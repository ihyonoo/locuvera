BEGIN;

CREATE TABLE IF NOT EXISTS users (
    user_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
    department TEXT,
    position TEXT,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    can_manage_nfc BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT users_staff_requires_position
        CHECK (role <> 'staff' OR position IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS readers (
    reader_id TEXT PRIMARY KEY,
    location_name TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tags (
    tag_id TEXT PRIMARY KEY,
    equipment_name TEXT NOT NULL,
    equipment_type TEXT,
    nfc_token TEXT,
    -- NTAG 424 DNA 칩의 7바이트 UID(14자리 hex). 위의 nfc_token과는 다르다 —
    -- 그쪽은 URL 경로에 들어가는 장비 토큰(pump-001)이고 이쪽이 실제 칩 UID다.
    ntag_uid TEXT,
    -- 마지막으로 받아들인 SDM 읽기 카운터. 언바인딩해도 절대 되돌리지 않는다 —
    -- 0으로 리셋하면 그 이전에 캡처된 URL이 전부 다시 유효해진다.
    ntag_last_ctr BIGINT NOT NULL DEFAULT 0,
    -- 현재 이 UID로 탭을 받는지 여부. 해제는 UID를 지우는 대신 이 값을 FALSE로 내린다.
    ntag_bound BOOLEAN NOT NULL DEFAULT FALSE,
    asset_status TEXT NOT NULL DEFAULT 'available',
    current_holder_user_id BIGINT REFERENCES users(user_id) ON UPDATE CASCADE,
    current_usage_id BIGINT,
    last_checkout_at TIMESTAMPTZ,
    last_returned_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT tags_asset_status_valid
        CHECK (asset_status IN ('available', 'checked_out', 'inactive')),
    CONSTRAINT tags_ntag_binding_consistent
        CHECK (ntag_bound = FALSE OR ntag_uid IS NOT NULL),
    CONSTRAINT tags_checkout_state_consistent
        CHECK (
            (asset_status = 'checked_out'
                AND current_holder_user_id IS NOT NULL
                AND current_usage_id IS NOT NULL
                AND last_checkout_at IS NOT NULL)
            OR
            (asset_status <> 'checked_out'
                AND current_holder_user_id IS NULL
                AND current_usage_id IS NULL)
        )
);

CREATE TABLE IF NOT EXISTS tag_state_history (
    history_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tag_id TEXT NOT NULL REFERENCES tags(tag_id) ON UPDATE CASCADE,
    reader_id TEXT NOT NULL REFERENCES readers(reader_id) ON UPDATE CASCADE,
    rssi INTEGER,
    observed_at TIMESTAMPTZ,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT NOT NULL DEFAULT 'rtls',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT tag_state_history_source_valid
        CHECK (source IN ('rtls', 'manual'))
);

-- usage_history keeps the denormalized fields that the current frontend reads,
-- and adds explicit state columns for the NFC checkout/return workflow.
CREATE TABLE IF NOT EXISTS usage_history (
    usage_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usage_status TEXT NOT NULL DEFAULT 'checked_out',
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON UPDATE CASCADE,
    user_name TEXT NOT NULL,
    user_position TEXT,
    user_department TEXT,
    returned_by_user_id BIGINT REFERENCES users(user_id) ON UPDATE CASCADE,
    returned_by_name TEXT,
    returned_by_position TEXT,
    returned_by_department TEXT,
    tag_id TEXT NOT NULL REFERENCES tags(tag_id) ON UPDATE CASCADE,
    equipment_name TEXT NOT NULL,
    equipment_type TEXT,
    equipment_nfc_token TEXT,
    checkout_method TEXT NOT NULL DEFAULT 'nfc',
    checkout_reader_id TEXT REFERENCES readers(reader_id) ON UPDATE CASCADE,
    checkout_location TEXT,
    checkout_at TIMESTAMPTZ NOT NULL,
    return_method TEXT,
    return_reader_id TEXT REFERENCES readers(reader_id) ON UPDATE CASCADE,
    return_location TEXT,
    returned_at TIMESTAMPTZ,
    -- 반납 시점에 한 번 계산되어 고정되는 스냅샷. [{"location": ..., "at": epoch}, ...] 형태로
    -- checkout_at~returned_at 사이 tag_state_history에서 관측된 중간 이동만 담는다(반납 후 재계산 안 함).
    movement_path JSONB,
    note TEXT,
    blockchain_tx_hash TEXT,
    blockchain_block_number BIGINT,
    blockchain_block_hash TEXT,
    blockchain_transaction_index INTEGER,
    blockchain_recorded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT usage_history_status_valid
        CHECK (usage_status IN ('checked_out', 'returned')),
    CONSTRAINT usage_history_checkout_method_valid
        CHECK (checkout_method IN ('nfc', 'manual', 'test')),
    CONSTRAINT usage_history_return_method_valid
        CHECK (return_method IS NULL OR return_method IN ('nfc', 'manual', 'test')),
    CONSTRAINT usage_history_return_time_valid
        CHECK (returned_at IS NULL OR returned_at >= checkout_at),
    CONSTRAINT usage_history_return_state_consistent
        CHECK (
            (usage_status = 'checked_out'
                AND returned_at IS NULL
                AND return_method IS NULL)
            OR
            (usage_status = 'returned'
                AND returned_at IS NOT NULL
                AND return_method IS NOT NULL)
        )
);

CREATE TABLE IF NOT EXISTS usage_nfc_events (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usage_id BIGINT REFERENCES usage_history(usage_id) ON DELETE SET NULL,
    tag_id TEXT NOT NULL REFERENCES tags(tag_id) ON UPDATE CASCADE,
    user_id BIGINT REFERENCES users(user_id) ON UPDATE CASCADE,
    equipment_nfc_token TEXT,
    action TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT 'accepted',
    reader_id TEXT REFERENCES readers(reader_id) ON UPDATE CASCADE,
    location_name TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT usage_nfc_events_action_valid
        CHECK (action IN ('checkout', 'return')),
    CONSTRAINT usage_nfc_events_result_valid
        CHECK (result IN ('accepted', 'rejected', 'ignored'))
);

-- SDM 탭 1회로 발급되는 단발성 세션. 실물 태그의 대여/반납은 이 세션을 요구한다.
-- 탭 1회가 만드는 유효한 CMAC은 하나뿐인데 실제 흐름은 조회(GET)와 실행(POST)으로
-- 요청이 두 번이라, 조회에서 카운터를 소비하며 발급한 세션이 실행 권한을 나른다.
-- Redis가 아니라 Postgres에 두는 이유는 두 가지다 — 카운터 소비와 같은 트랜잭션에
-- 묶을 수 있고, Redis는 이 저장소에서 fail-soft라 죽어도 되는 부가 의존성이다.
CREATE TABLE IF NOT EXISTS nfc_tap_sessions (
    session_id TEXT PRIMARY KEY,
    tag_id TEXT NOT NULL REFERENCES tags(tag_id) ON UPDATE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON UPDATE CASCADE,
    read_ctr BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_oauth_identities (
    identity_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    provider         TEXT NOT NULL,              -- 'google'
    provider_subject TEXT NOT NULL,              -- 공급자 고유 식별자(Google 'sub')
    email            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_oauth_identities_provider_subject_unique UNIQUE (provider, provider_subject)
);

CREATE TABLE IF NOT EXISTS auth_action_tokens (
    token_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT REFERENCES users(user_id) ON DELETE CASCADE,  -- oauth_handoff/pending은 NULL 가능
    purpose     TEXT NOT NULL,      -- 'email_verify' | 'password_reset' | 'oauth_handoff' | 'oauth_pending'
    token_hash  TEXT NOT NULL,      -- 원문 토큰의 SHA-256 (원문은 메일 링크/리다이렉트 URL에만 존재)
    payload     JSONB,              -- oauth pending 시 provider/sub/email/name 등
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_action_tokens_hash
    ON auth_action_tokens (token_hash);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS email TEXT,
    ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- 회원가입 없이 둘러보는 공개 데모 계정 표시. 계정 설정 API(탈퇴·비밀번호/이메일 변경 등)를
-- 이 플래그로 막아, 방문자가 데모 계정 자체를 망가뜨리지 못하게 한다.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

-- 기존 일반 관리자만 NFC 설정 변경 권한을 유지한다. 재실행 시 신규 관리자를 승격하지 않는다.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'can_manage_nfc'
    ) THEN
        ALTER TABLE users ADD COLUMN can_manage_nfc BOOLEAN NOT NULL DEFAULT FALSE;
        UPDATE users SET can_manage_nfc = TRUE WHERE role = 'admin' AND is_demo = FALSE;
    END IF;
END $$;

-- Google 전용 가입 계정은 비밀번호가 없을 수 있으므로 password_hash를 NULL 허용으로 완화한다.
ALTER TABLE users
    ALTER COLUMN password_hash DROP NOT NULL;

-- 이메일 인증 컬럼은 최초 도입 시에만 기존 계정을 인증됨(TRUE)으로 백필한다(로그인 잠김 방지).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'email_verified'
    ) THEN
        ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT FALSE;
        UPDATE users SET email_verified = TRUE;  -- 인증 기능 도입 이전 계정
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
    ON users (email)
    WHERE email IS NOT NULL;

ALTER TABLE readers
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 리더가 속한 층(1~5). 도면 위 정확한 좌표는 프론트 floorZoneBounds.ts의 폴리곤이 갖고
-- 있으므로 DB에는 "어느 층 폴리곤 세트를 볼지" 판단에만 쓰는 층 번호만 둔다.
-- is_real_hardware는 실물 하드웨어 여부(기본 TRUE) — 시뮬레이터가 만든 row만 명시적으로 FALSE로 심는다.
ALTER TABLE readers
    ADD COLUMN IF NOT EXISTS floor SMALLINT,
    ADD COLUMN IF NOT EXISTS is_real_hardware BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'readers_floor_valid') THEN
        ALTER TABLE readers ADD CONSTRAINT readers_floor_valid
            CHECK (floor IS NULL OR floor BETWEEN 1 AND 5);
    END IF;
END $$;

-- 이미 map_x/map_y가 있는 기존 DB에서 실제로 컬럼을 없앤다. IF EXISTS라 컬럼이 이미
-- 없는 환경(새로 만든 DB 등)에서 재실행해도 안전하다 — 이 스크립트의 멱등성을 그대로 유지.
ALTER TABLE readers
    DROP COLUMN IF EXISTS map_x,
    DROP COLUMN IF EXISTS map_y;

ALTER TABLE tags
    ADD COLUMN IF NOT EXISTS nfc_token TEXT,
    ADD COLUMN IF NOT EXISTS asset_status TEXT NOT NULL DEFAULT 'available',
    ADD COLUMN IF NOT EXISTS current_holder_user_id BIGINT REFERENCES users(user_id) ON UPDATE CASCADE,
    ADD COLUMN IF NOT EXISTS current_usage_id BIGINT,
    ADD COLUMN IF NOT EXISTS last_checkout_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_returned_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS is_real_hardware BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS ntag_uid TEXT,
    ADD COLUMN IF NOT EXISTS ntag_last_ctr BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ntag_bound BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tags_ntag_binding_consistent') THEN
        ALTER TABLE tags ADD CONSTRAINT tags_ntag_binding_consistent
            CHECK (ntag_bound = FALSE OR ntag_uid IS NOT NULL);
    END IF;
END $$;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_real_hardware BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE tag_state_history
    ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'rtls',
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE usage_history
    ADD COLUMN IF NOT EXISTS movement_path JSONB,
    ADD COLUMN IF NOT EXISTS usage_status TEXT NOT NULL DEFAULT 'checked_out',
    ADD COLUMN IF NOT EXISTS returned_by_user_id BIGINT REFERENCES users(user_id) ON UPDATE CASCADE,
    ADD COLUMN IF NOT EXISTS returned_by_name TEXT,
    ADD COLUMN IF NOT EXISTS returned_by_position TEXT,
    ADD COLUMN IF NOT EXISTS returned_by_department TEXT,
    ADD COLUMN IF NOT EXISTS equipment_type TEXT,
    ADD COLUMN IF NOT EXISTS equipment_nfc_token TEXT,
    ADD COLUMN IF NOT EXISTS checkout_method TEXT NOT NULL DEFAULT 'nfc',
    ADD COLUMN IF NOT EXISTS return_method TEXT,
    ADD COLUMN IF NOT EXISTS note TEXT,
    ADD COLUMN IF NOT EXISTS blockchain_tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS blockchain_block_number BIGINT,
    ADD COLUMN IF NOT EXISTS blockchain_block_hash TEXT,
    ADD COLUMN IF NOT EXISTS blockchain_transaction_index INTEGER,
    ADD COLUMN IF NOT EXISTS blockchain_recorded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE usage_history
SET usage_status = CASE
    WHEN returned_at IS NULL THEN 'checked_out'
    ELSE 'returned'
END
WHERE usage_status IS DISTINCT FROM CASE
    WHEN returned_at IS NULL THEN 'checked_out'
    ELSE 'returned'
END;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'usage_history' AND column_name = 'user_id')
        AND NOT EXISTS (SELECT 1 FROM usage_history WHERE user_id IS NULL) THEN
        ALTER TABLE usage_history ALTER COLUMN user_id SET NOT NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'usage_history' AND column_name = 'user_name')
        AND NOT EXISTS (SELECT 1 FROM usage_history WHERE user_name IS NULL) THEN
        ALTER TABLE usage_history ALTER COLUMN user_name SET NOT NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'usage_history' AND column_name = 'tag_id')
        AND NOT EXISTS (SELECT 1 FROM usage_history WHERE tag_id IS NULL) THEN
        ALTER TABLE usage_history ALTER COLUMN tag_id SET NOT NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'usage_history' AND column_name = 'equipment_name')
        AND NOT EXISTS (SELECT 1 FROM usage_history WHERE equipment_name IS NULL) THEN
        ALTER TABLE usage_history ALTER COLUMN equipment_name SET NOT NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'usage_history' AND column_name = 'checkout_at')
        AND NOT EXISTS (SELECT 1 FROM usage_history WHERE checkout_at IS NULL) THEN
        ALTER TABLE usage_history ALTER COLUMN checkout_at SET NOT NULL;
    END IF;
END $$;

-- 'maintenance' 상태를 쓰는 코드 경로가 없어 값 자체를 없앴다(2026-08-09). 이름만
-- 확인하는 IF NOT EXISTS로는 기존 DB의 예전 정의가 갱신되지 않으므로, 이 제약만
-- 매번 지웠다가 다시 만든다.
ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_asset_status_valid;
ALTER TABLE tags
    ADD CONSTRAINT tags_asset_status_valid
    CHECK (asset_status IN ('available', 'checked_out', 'inactive'));

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tags_checkout_state_consistent'
    ) THEN
        ALTER TABLE tags
            ADD CONSTRAINT tags_checkout_state_consistent
            CHECK (
                (asset_status = 'checked_out'
                    AND current_holder_user_id IS NOT NULL
                    AND current_usage_id IS NOT NULL
                    AND last_checkout_at IS NOT NULL)
                OR
                (asset_status <> 'checked_out'
                    AND current_holder_user_id IS NULL
                    AND current_usage_id IS NULL)
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tags_current_usage_id_fkey'
    ) THEN
        ALTER TABLE tags
            ADD CONSTRAINT tags_current_usage_id_fkey
            FOREIGN KEY (current_usage_id) REFERENCES usage_history(usage_id)
            ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tag_state_history_source_valid'
    ) THEN
        ALTER TABLE tag_state_history
            ADD CONSTRAINT tag_state_history_source_valid
            CHECK (source IN ('rtls', 'manual'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'usage_history_status_valid'
    ) THEN
        ALTER TABLE usage_history
            ADD CONSTRAINT usage_history_status_valid
            CHECK (usage_status IN ('checked_out', 'returned'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'usage_history_user_id_fkey'
    ) THEN
        ALTER TABLE usage_history
            ADD CONSTRAINT usage_history_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users(user_id)
            ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'usage_history_tag_id_fkey'
    ) THEN
        ALTER TABLE usage_history
            ADD CONSTRAINT usage_history_tag_id_fkey
            FOREIGN KEY (tag_id) REFERENCES tags(tag_id)
            ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'usage_history_checkout_reader_id_fkey'
    ) THEN
        ALTER TABLE usage_history
            ADD CONSTRAINT usage_history_checkout_reader_id_fkey
            FOREIGN KEY (checkout_reader_id) REFERENCES readers(reader_id)
            ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'usage_history_return_reader_id_fkey'
    ) THEN
        ALTER TABLE usage_history
            ADD CONSTRAINT usage_history_return_reader_id_fkey
            FOREIGN KEY (return_reader_id) REFERENCES readers(reader_id)
            ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'usage_history_checkout_method_valid'
    ) THEN
        ALTER TABLE usage_history
            ADD CONSTRAINT usage_history_checkout_method_valid
            CHECK (checkout_method IN ('nfc', 'manual', 'test'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'usage_history_return_method_valid'
    ) THEN
        ALTER TABLE usage_history
            ADD CONSTRAINT usage_history_return_method_valid
            CHECK (return_method IS NULL OR return_method IN ('nfc', 'manual', 'test'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'usage_history_return_time_valid'
    ) THEN
        ALTER TABLE usage_history
            ADD CONSTRAINT usage_history_return_time_valid
            CHECK (returned_at IS NULL OR returned_at >= checkout_at);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'usage_history_return_state_consistent'
    ) THEN
        ALTER TABLE usage_history
            ADD CONSTRAINT usage_history_return_state_consistent
            CHECK (
                (usage_status = 'checked_out'
                    AND returned_at IS NULL
                    AND return_method IS NULL)
                OR
                (usage_status = 'returned'
                    AND returned_at IS NOT NULL
                    AND return_method IS NOT NULL)
            );
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_nfc_token
    ON tags (nfc_token)
    WHERE nfc_token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_ntag_uid
    ON tags (ntag_uid)
    WHERE ntag_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nfc_tap_sessions_expires_at
    ON nfc_tap_sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_tags_asset_status
    ON tags (asset_status);

CREATE INDEX IF NOT EXISTS idx_tag_state_history_tag_decided_at
    ON tag_state_history (tag_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_tag_state_history_decided_at
    ON tag_state_history (decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_history_checkout_at
    ON usage_history (checkout_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_history_user_id
    ON usage_history (user_id);

CREATE INDEX IF NOT EXISTS idx_usage_history_tag_id
    ON usage_history (tag_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_history_open_usage_per_tag
    ON usage_history (tag_id)
    WHERE usage_status = 'checked_out';


COMMIT;
