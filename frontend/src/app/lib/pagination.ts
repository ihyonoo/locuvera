// 관리자 목록의 클라이언트 사이드 페이징. 목록 데이터는 이미 전부 받아둔 상태라
// 페이지 전환은 슬라이스만 바꾸면 된다(재조회 없음).
export const PAGE_SIZE_OPTIONS = [5, 10, 20, 50, 100];

export const DEFAULT_PAGE_SIZE = 10;

// 페이지 번호 줄이 한 줄을 넘지 않도록, 이 개수를 넘으면 앞뒤를 '…'로 접는다.
const MAX_VISIBLE_PAGES = 7;

// 접힌 상태에서 현재 페이지 주변으로 항상 보여줄 페이지 수.
const WINDOW_SIZE = 3;

export function getTotalPages(totalItems: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalItems / pageSize));
}

export function clampPage(page: number, totalPages: number): number {
  return Math.min(totalPages, Math.max(1, page));
}

export function getPageSlice<T>(items: T[], page: number, pageSize: number): T[] {
  const safePage = clampPage(page, getTotalPages(items.length, pageSize));
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

/** 페이지 번호 줄에 그릴 항목. 'ellipsis'는 생략된 구간을 뜻한다. */
export type PageListItem = number | 'ellipsis';

export function buildPageList(currentPage: number, totalPages: number): PageListItem[] {
  if (totalPages <= MAX_VISIBLE_PAGES) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const windowStart = clampPage(currentPage - 1, totalPages - WINDOW_SIZE + 1);
  const windowEnd = Math.min(totalPages, windowStart + WINDOW_SIZE - 1);

  const pages = new Set<number>([1, totalPages]);
  for (let page = windowStart; page <= windowEnd; page += 1) pages.add(page);

  const sorted = Array.from(pages).sort((a, b) => a - b);
  const result: PageListItem[] = [];
  sorted.forEach((page, index) => {
    const previous = sorted[index - 1];
    if (previous !== undefined && page - previous > 1) result.push('ellipsis');
    result.push(page);
  });
  return result;
}
