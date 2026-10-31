from pydantic import BaseModel


class Observation(BaseModel):
    tag_id: str
    rssi: int
    count: int
    last_seen: int


class Payload(BaseModel):
    reader_id: str
    ts: int
    observations: list[Observation]


class LoginRequest(BaseModel):
    username: str
    password: str
    role: str


class DemoLoginRequest(BaseModel):
    role: str = "staff"


class SignupRequestCreate(BaseModel):
    employee_no: str
    display_name: str
    email: str


class SignupApproveRequest(BaseModel):
    role: str = "staff"
    department: str | None = None
    position: str | None = None


class VerifyEmailRequest(BaseModel):
    token: str


class ResendVerificationRequest(BaseModel):
    email: str


class FindIdRequest(BaseModel):
    email: str


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    password: str


class SessionExchangeRequest(BaseModel):
    code: str


class GoogleCompleteRequest(BaseModel):
    pending_token: str
    username: str
    display_name: str | None = None
    role: str = "staff"
    department: str | None = None
    position: str | None = None
    password: str | None = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class ChangeEmailRequest(BaseModel):
    new_email: str
    current_password: str


class WithdrawRequest(BaseModel):
    current_password: str


class NfcMappingUpsertRequest(BaseModel):
    tag_id: str
    nfc_token: str


class NtagBindingRequest(BaseModel):
    tag_id: str
    ntag_uid: str


class NfcUsageActionRequest(BaseModel):
    nfc_token: str
    # 실물 태그에서는 필수다. 시뮬레이터는 물리 태그가 없어 보내지 않으므로 옵셔널로 둔다.
    tap_session: str | None = None
