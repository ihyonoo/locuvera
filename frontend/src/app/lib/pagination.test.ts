import { describe, it, expect } from 'vitest';
import {
  buildPageList,
  clampPage,
  DEFAULT_PAGE_SIZE,
  getPageSlice,
  getTotalPages,
  PAGE_SIZE_OPTIONS,
} from './pagination';

describe('getTotalPages', () => {
  it('counts a partial last page as its own page', () => {
    expect(getTotalPages(21, 10)).toBe(3);
  });

  it('is 1 when there is nothing to show, so the pager never renders an empty range', () => {
    expect(getTotalPages(0, 10)).toBe(1);
  });
});

describe('clampPage', () => {
  it('keeps a page inside the available range', () => {
    expect(clampPage(5, 3)).toBe(3);
    expect(clampPage(0, 3)).toBe(1);
    expect(clampPage(2, 3)).toBe(2);
  });
});

describe('getPageSlice', () => {
  const items = Array.from({ length: 25 }, (_, i) => i + 1);

  it('returns the slice belonging to the requested page', () => {
    expect(getPageSlice(items, 2, 10)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it('returns the remainder on the last page', () => {
    expect(getPageSlice(items, 3, 10)).toEqual([21, 22, 23, 24, 25]);
  });

  it('falls back to the last page when the requested page is out of range', () => {
    expect(getPageSlice(items, 9, 10)).toEqual([21, 22, 23, 24, 25]);
  });
});

describe('buildPageList', () => {
  it('lists every page when they all fit', () => {
    expect(buildPageList(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('collapses the tail when the current page is near the start', () => {
    expect(buildPageList(1, 10)).toEqual([1, 2, 3, 'ellipsis', 10]);
  });

  it('collapses both sides when the current page is in the middle', () => {
    expect(buildPageList(5, 10)).toEqual([1, 'ellipsis', 4, 5, 6, 'ellipsis', 10]);
  });

  it('collapses the head when the current page is near the end', () => {
    expect(buildPageList(10, 10)).toEqual([1, 'ellipsis', 8, 9, 10]);
  });
});

describe('PAGE_SIZE_OPTIONS', () => {
  it('offers the sizes the admin lists use', () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([5, 10, 20, 50, 100]);
  });

  it('starts at ten items per page', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(10);
  });
});
