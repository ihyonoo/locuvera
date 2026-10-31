"""이메일 발송 유틸리티.

Gmail SMTP(STARTTLS, 587)를 기본으로 하며, SMTP 자격증명이 설정되지 않은 개발
환경에서는 실제 발송 대신 링크를 로그로 출력하는 dev 폴백으로 동작한다.
"""

import logging
import smtplib
from email.message import EmailMessage

try:
    from backend.settings import (
        ACCOUNT_SETUP_TTL_SEC,
        SMTP_FROM,
        SMTP_HOST,
        SMTP_PASSWORD,
        SMTP_PORT,
        SMTP_USER,
    )
except ModuleNotFoundError as exc:
    if not exc.name or not exc.name.startswith("backend"):
        raise
    from settings import (
        ACCOUNT_SETUP_TTL_SEC,
        SMTP_FROM,
        SMTP_HOST,
        SMTP_PASSWORD,
        SMTP_PORT,
        SMTP_USER,
    )

logger = logging.getLogger("mediledger.email")


def _smtp_configured() -> bool:
    return bool(SMTP_HOST and SMTP_USER and SMTP_PASSWORD and SMTP_FROM)


def _send(to: str, subject: str, body: str) -> None:
    """실제 발송 또는 dev 폴백(로그 출력)."""
    if not _smtp_configured():
        # 개발용: 실제 발송 없이 본문을 로그로 남긴다.
        logger.warning(
            "[DEV-EMAIL] SMTP 미설정 — 실제 발송 생략. to=%s subject=%s\n%s",
            to,
            subject,
            body,
        )
        return

    message = EmailMessage()
    message["From"] = SMTP_FROM
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.send_message(message)
    except Exception:
        logger.exception("이메일 발송 실패 to=%s subject=%s", to, subject)
        # 발송 실패를 호출부로 전파하지 않는다(계정 열거/타이밍 노출 방지).


def send_verification_email(to: str, link: str) -> None:
    subject = "[Locuvera] 이메일 인증을 완료해 주세요"
    body = (
        "Locuvera 회원가입을 완료하려면 아래 링크에서 이메일 인증을 진행해 주세요.\n\n"
        f"{link}\n\n"
        "이 링크는 일정 시간 후 만료됩니다.\n"
        "본인이 요청하지 않았다면 이 메일을 무시하셔도 됩니다."
    )
    _send(to, subject, body)


def send_reset_email(to: str, link: str) -> None:
    subject = "[Locuvera] 비밀번호 재설정 안내"
    body = (
        "비밀번호를 재설정하려면 아래 링크에서 새 비밀번호를 설정해 주세요.\n\n"
        f"{link}\n\n"
        "이 링크는 일정 시간 후 만료됩니다.\n"
        "본인이 요청하지 않았다면 이 메일을 무시하셔도 됩니다."
    )
    _send(to, subject, body)


def send_account_setup_email(to: str, username: str, role: str, link: str) -> None:
    subject = "[Locuvera] 가입 승인 안내"
    role_label = "관리자" if role == "admin" else "의료진"
    body = (
        "Locuvera 가입 요청이 승인되었습니다.\n\n"
        f"사번(로그인 아이디): {username}\n"
        f"권한: {role_label} — 로그인 화면에서 '{role_label}'을 선택하세요.\n\n"
        "아래 링크에서 비밀번호를 설정한 뒤 로그인해 주세요.\n\n"
        f"{link}\n\n"
        f"이 링크는 {ACCOUNT_SETUP_TTL_SEC // 3600}시간 동안 유효합니다. "
        "만료되면 로그인 화면의 '비밀번호 찾기'로 새 링크를 받으세요."
    )
    _send(to, subject, body)


def send_find_id_email(to: str, usernames: list[str]) -> None:
    subject = "[Locuvera] 아이디 찾기 안내"
    joined = "\n".join(f"  - {name}" for name in usernames)
    body = (
        "요청하신 이메일로 가입된 아이디는 다음과 같습니다.\n\n"
        f"{joined}\n\n"
        "본인이 요청하지 않았다면 이 메일을 무시하셔도 됩니다."
    )
    _send(to, subject, body)
