#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EternalZero 自动续期脚本（模拟表单登录，防 419）

此脚本具备以下能力：
1. 自动获取登录页面 CSRF token
2. 模拟表单登录（邮箱+密码）
3. 获取服务器列表
4. 判断冷却时间并在可用时自动续期
5. Telegram 推送通知
6. 丰富的调试日志，方便排查问题

通过 requests.Session 保持会话，配合 BeautifulSoup 提取 token，
并增强请求头、重试策略和错误处理，以提升对网站结构变化
和 Cloudflare 保护的适应能力。
"""

from __future__ import annotations

import datetime
import logging
import os
import random
import re
import time
from pathlib import Path
from typing import Dict, Iterable, List, Optional

import requests
from bs4 import BeautifulSoup
from requests import Response
from requests.adapters import HTTPAdapter
from urllib.parse import unquote
from urllib3.util.retry import Retry

# ==================== 配置区 ====================
EMAIL = "opcfgyufxc@aaliyun.nyc.mn"  # 登录邮箱
PASSWORD = "URm8TTCKZGePCRe"  # 登录密码
BASE_URL = "https://gpanel.eternalzero.cloud"

# Telegram 推送（可选）
TG_BOT_TOKEN = "在此填写你的BotToken"
TG_CHAT_ID = "在此填写你的ChatID"

# 每次检测间隔（秒）
CHECK_INTERVAL = 1800  # 30 分钟

# 额外调试配置
DEBUG_ENABLED = os.environ.get("EZ_DEBUG", "1") != "0"
DEBUG_DUMP_HTML = os.environ.get("EZ_DEBUG_DUMP", "0") == "1"
# ==================== 配置区 ====================


def _build_logger() -> logging.Logger:
    level = logging.DEBUG if DEBUG_ENABLED else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s | %(levelname)-7s | %(message)s",
    )
    return logging.getLogger("eternalzero")


log = _build_logger()

# 常见桌面 UA 列表，减少被反爬虫针对的概率
USER_AGENTS: List[str] = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.3 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
]

BASE_HEADERS: Dict[str, str] = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

JSON_HEADERS: Dict[str, str] = {
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
}


def build_session() -> requests.Session:
    """创建带重试、默认头部的 Session 对象。"""

    session = requests.Session()
    session.headers.update(BASE_HEADERS)
    ua = random.choice(USER_AGENTS)
    session.headers["User-Agent"] = ua
    log.debug("使用 User-Agent: %s", ua)

    retry_strategy = Retry(
        total=3,
        backoff_factor=0.8,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("HEAD", "GET", "OPTIONS", "POST"),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def tg_push(msg: str) -> None:
    """发送 Telegram 推送。"""

    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        log.debug("未配置 Telegram 推送，忽略消息: %s", msg)
        return

    url = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage"
    payload = {"chat_id": TG_CHAT_ID, "text": msg}
    try:
        resp = requests.post(url, json=payload, timeout=10)
        if not resp.ok:
            log.warning(
                "Telegram 推送失败（HTTP %s）: %s", resp.status_code, resp.text
            )
    except Exception as exc:  # noqa: BLE001 - 保证推送失败不会中断主流程
        log.warning("Telegram 推送异常: %s", exc)


def dump_html(response: Response, label: str) -> None:
    if not DEBUG_DUMP_HTML:
        return

    path = Path(__file__).with_name(f"debug_{label}.html")
    try:
        path.write_text(response.text, encoding="utf-8")
        log.debug("响应内容已写入 %s", path)
    except Exception as exc:  # noqa: BLE001 - 调试辅助
        log.debug("写入调试 HTML 失败: %s", exc)


def ensure_not_cloudflare(response: Response) -> None:
    """检查是否触发 Cloudflare 等防护。"""

    if response.status_code in (403, 503):
        raise RuntimeError(
            "疑似被防火墙拦截（HTTP %s），请稍后重试或手动验证" % response.status_code
        )

    text_lower = response.text.lower()
    if any(keyword in text_lower for keyword in ("cloudflare", "just a moment")):
        raise RuntimeError("检测到 Cloudflare 拦截，请先完成浏览器验证")

    if "captcha" in text_lower:
        raise RuntimeError("检测到验证码挑战，需要人工处理")


def extract_csrf_token(html: str) -> str:
    """利用 BeautifulSoup 提取隐藏字段 _token。"""

    soup = BeautifulSoup(html, "html.parser")

    # 优先从 input[name="_token"] 中获取
    token_input = soup.find("input", attrs={"name": "_token"})
    if token_input and token_input.get("value"):
        return token_input["value"].strip()

    # 兼容 meta[name="csrf-token"] 等写法
    meta_token = soup.find("meta", attrs={"name": "csrf-token"})
    if meta_token and meta_token.get("content"):
        return meta_token["content"].strip()

    # 兜底方案：尝试从脚本内容中匹配
    regex_patterns: Iterable[str] = (
        r'name="_token"\s+value="([^"]+)"',
        r"name='_token'\s+value='([^']+)'",
        r"_token['\"]\s*:\s*['\"]([^'\"]+)['\"]",
    )
    for pattern in regex_patterns:
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            return match.group(1).strip()

    raise ValueError("未能在登录页面中找到 CSRF token (_token)")


def get_xsrf_token(session: requests.Session) -> Optional[str]:
    token = session.cookies.get("XSRF-TOKEN")
    if not token:
        return None
    return unquote(token)


def fetch_login_page(session: requests.Session) -> Response:
    url = f"{BASE_URL}/auth/login"
    log.debug("正在获取登录页: %s", url)
    response = session.get(url, timeout=15)
    dump_html(response, "login_page")
    ensure_not_cloudflare(response)

    if response.status_code != 200:
        raise RuntimeError(
            f"获取登录页面失败，HTTP {response.status_code}: {response.text[:200]}"
        )

    xsrf_token = get_xsrf_token(session)
    if not xsrf_token:
        raise RuntimeError("未获取到初始 XSRF-TOKEN cookie")

    log.debug("成功获取初始 XSRF-TOKEN: %s", xsrf_token)
    return response


def submit_login_form(
    session: requests.Session, csrf_token: str
) -> requests.Session:
    payload = {
        "email": EMAIL,
        "password": PASSWORD,
        "_token": csrf_token,
    }
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": BASE_URL,
        "Referer": f"{BASE_URL}/auth/login",
        "User-Agent": session.headers.get("User-Agent", "Mozilla/5.0"),
    }

    log.debug("提交登录表单: %s", {**payload, "password": "***"})
    response = session.post(
        f"{BASE_URL}/auth/login",
        data=payload,
        headers=headers,
        timeout=15,
        allow_redirects=True,
    )
    dump_html(response, "login_result")
    ensure_not_cloudflare(response)

    if response.status_code not in (200, 302):
        raise RuntimeError(
            f"登录请求失败，HTTP {response.status_code}: {response.text[:200]}"
        )

    ptero_session = session.cookies.get("pterodactyl_session")
    xsrf_token = get_xsrf_token(session)
    if not ptero_session or not xsrf_token:
        raise RuntimeError("登录失败，未获得会话或 CSRF cookie")

    log.info("[✅] 登录成功")
    return session


def login() -> requests.Session:
    """模拟表单登录，返回已登录的 session。"""

    session = build_session()
    login_page = fetch_login_page(session)
    csrf_token = extract_csrf_token(login_page.text)
    log.debug("提取到登录 CSRF token: %s", csrf_token)
    return submit_login_form(session, csrf_token)


def get_json_headers(session: requests.Session) -> Dict[str, str]:
    headers = dict(JSON_HEADERS)
    headers["User-Agent"] = session.headers.get("User-Agent", "Mozilla/5.0")
    headers["Referer"] = f"{BASE_URL}/"

    xsrf_token = get_xsrf_token(session)
    if xsrf_token:
        headers["X-CSRF-TOKEN"] = xsrf_token
    else:
        raise RuntimeError("缺少 X-CSRF-TOKEN，无法发起 API 请求")

    return headers


def get_servers(session: requests.Session) -> List[Dict[str, object]]:
    """获取服务器列表。"""

    url = f"{BASE_URL}/api/client"
    headers = get_json_headers(session)
    response = session.get(url, headers=headers, timeout=15)
    dump_html(response, "servers")

    if response.status_code != 200:
        raise RuntimeError(f"获取服务器列表失败，HTTP {response.status_code}")

    try:
        data = response.json().get("data", [])
    except ValueError as exc:
        raise RuntimeError(f"解析服务器列表 JSON 失败: {exc}") from exc

    servers: List[Dict[str, object]] = []
    for item in data:
        attrs = item.get("attributes", {}) if isinstance(item, dict) else {}
        servers.append(
            {
                "name": attrs.get("name"),
                "identifier": attrs.get("identifier"),
                "cooldown": attrs.get("cooldown", 0),
            }
        )

    log.info("发现 %s 台服务器", len(servers))
    return servers


def renew_server(session: requests.Session, identifier: str, name: str) -> None:
    url = f"{BASE_URL}/api/client/servers/{identifier}/renew"
    headers = get_json_headers(session)

    response = session.post(url, headers=headers, timeout=15)
    dump_html(response, f"renew_{identifier}")

    if response.ok:
        msg = f"✅ [{name}] 续期成功"
        log.info(msg)
        tg_push(msg)
    else:
        msg = f"❌ [{name}] 续期失败: {response.text[:200]}"
        log.warning(msg)
        tg_push(msg)


def handle_servers(session: requests.Session) -> None:
    servers = get_servers(session)
    if not servers:
        msg = "⚠️ 未找到任何服务器"
        log.warning(msg)
        tg_push(msg)
        return

    for srv in servers:
        name = srv.get("name") or "未知服务器"
        identifier = srv.get("identifier")
        cooldown = int(srv.get("cooldown", 0) or 0)

        log.info("服务器: %s", name)
        log.info("冷却时间: %s 分钟", cooldown)

        if cooldown > 0:
            msg = f"⏳ [{name}] 仍在冷却中 ({cooldown} 分钟)"
            log.info(msg)
            tg_push(msg)
            continue

        if not identifier:
            log.warning("服务器 %s 缺少 identifier 字段，跳过", name)
            continue

        renew_server(session, identifier, name)


def main() -> None:
    log.info("=== EternalZero 自动续期脚本启动（模拟表单登录） ===")
    while True:
        start_time = datetime.datetime.now()
        try:
            session = login()
            handle_servers(session)
        except Exception as exc:  # noqa: BLE001 - 顶层捕获，防止脚本退出
            msg = f"❌ 脚本运行出错：{exc}"
            log.error("[错误] %s", exc, exc_info=DEBUG_ENABLED)
            tg_push(msg)

        log.info(
            "[%s] 等待 %s 分钟后再次检查...",
            start_time.strftime("%Y-%m-%d %H:%M:%S"),
            CHECK_INTERVAL // 60,
        )
        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
