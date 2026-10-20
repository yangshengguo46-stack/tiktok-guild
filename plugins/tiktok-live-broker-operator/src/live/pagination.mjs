function boundedInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

export async function paginate({
  fetchPage,
  cursor = null,
  pageSize = 100,
  maxPages = 1
}) {
  if (typeof fetchPage !== "function") throw new TypeError("fetchPage must be a function.");
  boundedInteger(pageSize, "pageSize", 200);
  boundedInteger(maxPages, "maxPages", 200);
  if (cursor !== null && (typeof cursor !== "string" || cursor.length > 512)) {
    throw new TypeError("cursor must be null or a bounded string.");
  }

  const items = [];
  const seen = new Set(cursor === null ? [] : [cursor]);
  let nextCursor = cursor;
  let pagesRead = 0;
  let complete = false;

  while (pagesRead < maxPages) {
    const page = await fetchPage({ cursor: nextCursor, pageSize });
    if (!page || typeof page !== "object" || !Array.isArray(page.items)) {
      throw new TypeError("fetchPage returned an invalid page.");
    }
    if (page.next_cursor !== null && (typeof page.next_cursor !== "string" || page.next_cursor.length > 512)) {
      throw new TypeError("fetchPage returned an invalid next cursor.");
    }
    if (page.items.length > pageSize) throw new TypeError("fetchPage exceeded pageSize.");
    items.push(...page.items);
    pagesRead += 1;
    nextCursor = page.next_cursor;
    if (nextCursor === null) {
      complete = true;
      break;
    }
    if (page.items.length === 0 || seen.has(nextCursor)) {
      throw new TypeError("fetchPage did not advance its cursor.");
    }
    seen.add(nextCursor);
  }

  return Object.freeze({
    items: Object.freeze(items),
    pagination: Object.freeze({
      complete,
      next_cursor: nextCursor,
      pages_read: pagesRead,
      page_size: pageSize
    })
  });
}
