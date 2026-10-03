-- 서명된 RTLS 입력을 켜기 전에 실물 리더 두 대를 명시적으로 등록한다.
-- 기존 리더의 비어 있는 위치 정보만 채우고 비활성 상태는 유지한다.
INSERT INTO readers (reader_id, location_name, floor, is_active, is_real_hardware)
VALUES
    ('M501', '중앙수술센터', 5, TRUE, TRUE),
    ('M502', '통원수술센터', 5, TRUE, TRUE)
ON CONFLICT (reader_id) DO UPDATE SET
    location_name = COALESCE(NULLIF(readers.location_name, ''), EXCLUDED.location_name),
    floor = COALESCE(readers.floor, EXCLUDED.floor),
    is_real_hardware = TRUE;
