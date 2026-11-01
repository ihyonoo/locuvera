"""장비 카탈로그 — 종류별 행동 프로파일과 50개 인스턴스.

전부 실제로 RTLS 태그를 붙이는 이동형 의료기기다. 고정 설치물(유닛체어·세극등·MRI)은
대상이 아니다. 장비는 임상적으로 필요한 구역에 몰려 있고, 외래 진료실만 있는 9개
구역에는 상주 장비가 없다 — 42개 구역에 고르게 뿌리면 오히려 시뮬레이션처럼 보인다.
"""

from dataclasses import dataclass, field
from enum import StrEnum

from simulation.topology import zones

# 병원 전체가 공유하는 iBeacon UUID.
HOSPITAL_BEACON_UUID = "a83f2c9e-6b1d-4e2a-9c77-51f8d20b6a44"

# major는 장비 출처 구분자다: 1 = 실물 IoT 장비, 2 = 시뮬레이션 장비.
# minor는 그 분류 안에서 1부터 올라가는 3자리 연번이다.
SIMULATION_BEACON_MAJOR = 2


class Mobility(StrEnum):
    FLOOR = "floor"  # 같은 층 전체
    HOME2 = "home2"  # home에서 그래프 거리 2 이내
    HOME1 = "home1"  # home에서 그래프 거리 1 이내
    FIXED = "fixed"  # 지정 구역 집합에만


class DemandClass(StrEnum):
    ACUTE = "acute"  # 24시간 가동, 주말 영향 적음
    OUTPATIENT = "outpatient"  # 외래 진료 시간에 집중


@dataclass(frozen=True)
class EquipmentType:
    name: str
    slug: str
    mobility: Mobility
    home_return_rate: float
    checkout_rate_per_hour: float  # 대당 시간당 대여 발생률(주간 피크 기준)
    usage_median_sec: float  # 총 사용 시간 중앙값
    demand_class: DemandClass
    roles: tuple[str, ...]
    fixed_zones: tuple[str, ...] = ()


_TYPE_LIST = (
    EquipmentType("수액펌프", "pump", Mobility.FLOOR, 0.30, 0.18, 7200, DemandClass.ACUTE,
                  ("간호사", "수간호사", "전공의")),
    EquipmentType("시린지펌프", "syringe", Mobility.FLOOR, 0.30, 4.0, 9000, DemandClass.ACUTE,
                  ("간호사", "수술실간호사", "전공의")),
    EquipmentType("이동형 환자모니터", "monitor", Mobility.FLOOR, 0.60, 7.0, 5400, DemandClass.ACUTE,
                  ("간호사", "전공의", "수술실간호사", "응급구조사")),
    EquipmentType("제세동기", "defib", Mobility.HOME2, 0.95, 0.02, 1800, DemandClass.ACUTE,
                  ("응급구조사", "전문의", "간호사")),
    EquipmentType("이동형 인공호흡기", "vent", Mobility.HOME2, 0.85, 4.0, 10800, DemandClass.ACUTE,
                  ("호흡치료사", "간호사", "전문의")),
    EquipmentType("이동형 흡인기", "suction", Mobility.FLOOR, 0.60, 18.0, 1800, DemandClass.ACUTE,
                  ("간호사", "응급구조사", "호흡치료사")),
    EquipmentType("응급카트", "crash", Mobility.HOME2, 0.95, 0.05, 1500, DemandClass.ACUTE,
                  ("응급구조사", "수간호사", "간호사")),
    EquipmentType("태아감시장치", "ctg", Mobility.FIXED, 0.70, 8.0, 4320, DemandClass.ACUTE,
                  ("간호사", "전문의", "수간호사"), ("M404", "M405")),
    EquipmentType("휴대용 초음파진단기", "us", Mobility.FLOOR, 0.60, 0.50, 1500, DemandClass.OUTPATIENT,
                  ("전문의", "전공의")),
    EquipmentType("이동형 심전도기", "ecg", Mobility.HOME2, 0.60, 0.70, 900, DemandClass.OUTPATIENT,
                  ("간호사", "전공의", "임상병리사")),
    EquipmentType("혈액투석기", "hd", Mobility.FIXED, 0.98, 0.20, 14400, DemandClass.OUTPATIENT,
                  ("투석실간호사",), ("M409", "M410")),
    EquipmentType("이동형 C-arm", "carm", Mobility.HOME2, 0.85, 0.25, 3600, DemandClass.OUTPATIENT,
                  ("방사선사", "전문의")),
    EquipmentType("이동형 X선촬영장치", "xray", Mobility.FLOOR, 0.85, 0.80, 1080, DemandClass.OUTPATIENT,
                  ("방사선사",)),
    EquipmentType("이동형 마취기", "anesth", Mobility.HOME1, 0.85, 0.15, 7200, DemandClass.OUTPATIENT,
                  ("마취간호사", "전문의")),
    EquipmentType("이동형 원심분리기", "centri", Mobility.HOME2, 0.85, 0.40, 1500, DemandClass.OUTPATIENT,
                  ("임상병리사",)),
    EquipmentType("검체이송카트", "speccart", Mobility.FLOOR, 0.30, 1.20, 1080, DemandClass.OUTPATIENT,
                  ("임상병리사", "간호사")),
    EquipmentType("이동형 폐기능검사기", "spiro", Mobility.HOME2, 0.85, 0.50, 1200, DemandClass.OUTPATIENT,
                  ("호흡치료사", "임상병리사")),
    EquipmentType("전기자극치료기", "estim", Mobility.HOME2, 0.60, 0.80, 1500, DemandClass.OUTPATIENT,
                  ("물리치료사", "작업치료사")),
    EquipmentType("내시경 카트", "endocart", Mobility.HOME2, 0.85, 0.40, 2100, DemandClass.OUTPATIENT,
                  ("간호사", "전공의")),
    EquipmentType("이동형 뇌파검사기", "eeg", Mobility.HOME2, 0.85, 0.35, 3000, DemandClass.OUTPATIENT,
                  ("임상병리사", "전공의")),
)  # fmt: skip

TYPES: dict[str, EquipmentType] = {profile.slug: profile for profile in _TYPE_LIST}

# (슬러그, home 구역). 순서가 곧 tag_id의 minor 연번이므로 중간에 끼워 넣지 말 것 —
# 뒤따르는 모든 태그 ID가 밀린다. 새 장비는 항상 목록 끝에 추가한다.
PLACEMENTS: tuple[tuple[str, str], ...] = (
    # 1층 — 응급의료센터, 영상의학센터
    ("monitor", "M101"), ("defib", "M101"), ("suction", "M101"),
    ("pump", "M102"), ("monitor", "M102"), ("defib", "M102"), ("vent", "M102"), ("crash", "M102"),
    ("xray", "M106"),
    # 2층 — 외래 검사실, 권역응급중환자실
    ("speccart", "M201"),
    ("spiro", "M202"),
    ("ecg", "M203"),
    ("pump", "M204"),
    ("pump", "M205"),
    ("suction", "M206"),
    ("us", "M207"),
    ("syringe", "M208"), ("monitor", "M208"), ("defib", "M208"), ("crash", "M208"),
    ("eeg", "M209"),
    ("endocart", "M211"),
    # 3층 — 외래 전문 진료센터
    ("ecg", "M301"),
    ("us", "M303"),
    ("monitor", "M304"),
    ("suction", "M305"),
    ("carm", "M308"),
    ("estim", "M309"), ("estim", "M309"),
    ("us", "M310"),
    # 4층 — 검사·모자·신장 센터
    ("centri", "M401"), ("speccart", "M401"),
    ("monitor", "M403"),
    ("ctg", "M404"),
    ("ctg", "M405"), ("ctg", "M405"),
    ("us", "M406"),
    ("syringe", "M408"),
    ("hd", "M409"), ("hd", "M409"),
    ("hd", "M410"),
    # 5층 — 중환자실, 마취통증의학과 (수술센터 M501/M502는 실물 리더 담당이라 제외)
    ("syringe", "M503"), ("vent", "M503"),
    ("syringe", "M504"), ("monitor", "M504"), ("defib", "M504"),
    ("pump", "M505"), ("vent", "M505"),
    ("carm", "M506"),
    ("anesth", "M507"),
)  # fmt: skip


# 로컬 개발 DB에 실물 하드웨어 태그(수액펌프-001, nfc pump-001)가 이미 등록되어 있어
# 그 이름을 침범하지 않도록 pump 슬러그의 시작 번호를 한 칸 밀어둔다.
RESERVED_START_INDEX: dict[str, int] = {"pump": 2}


@dataclass(frozen=True)
class Equipment:
    tag_id: str
    equipment_name: str
    equipment_type: str
    nfc_token: str
    home_zone: str
    floor: int
    profile: EquipmentType = field(compare=False)


def _build_equipment() -> tuple[Equipment, ...]:
    per_type_index: dict[str, int] = {}
    built: list[Equipment] = []
    for sequence, (slug, zone_id) in enumerate(PLACEMENTS, start=1):
        profile = TYPES[slug]
        floor = zones.ZONE_BY_ID[zone_id].floor
        start = RESERVED_START_INDEX.get(slug, 1)
        index = per_type_index[slug] = per_type_index.get(slug, start - 1) + 1
        built.append(
            Equipment(
                tag_id=f"{HOSPITAL_BEACON_UUID}:{SIMULATION_BEACON_MAJOR}:{sequence:03d}",
                equipment_name=f"{profile.name}-{index:03d}",
                equipment_type=profile.name,
                nfc_token=f"{slug}-{index:03d}",
                home_zone=zone_id,
                floor=floor,
                profile=profile,
            )
        )
    return tuple(built)


EQUIPMENT: tuple[Equipment, ...] = _build_equipment()
EQUIPMENT_BY_TAG: dict[str, Equipment] = {item.tag_id: item for item in EQUIPMENT}

# 그 종류의 장비가 실제로 상주하는 구역이 주 사용처다. 사용지 선택 시 가중치를 높게 준다.
AFFINITY_ZONES: dict[str, frozenset[str]] = {
    slug: frozenset(zone_id for placed_slug, zone_id in PLACEMENTS if placed_slug == slug) for slug in TYPES
}
