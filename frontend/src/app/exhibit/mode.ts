// 전시 모드 스위치. ?exhibit=1로 켜고 ?exhibit=0으로 끈다
// 탭을 닫기 전까지 기억해 주소가 바뀌거나 새로 고쳐도 유지한다
const EXHIBIT_FLAG_KEY = 'locuvera-exhibit';

export function syncExhibitFlag(search: string): boolean {
  const requested = new URLSearchParams(search).get('exhibit');
  try {
    if (requested === '1') sessionStorage.setItem(EXHIBIT_FLAG_KEY, '1');
    if (requested === '0') sessionStorage.removeItem(EXHIBIT_FLAG_KEY);
    return sessionStorage.getItem(EXHIBIT_FLAG_KEY) === '1';
  } catch {
    return requested === '1';
  }
}
