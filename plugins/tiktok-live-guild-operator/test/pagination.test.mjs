import assert from "node:assert/strict";
import test from "node:test";

import { paginate } from "../src/live/pagination.mjs";

function syntheticFetcher(total) {
  return async ({ cursor, pageSize }) => {
    const offset = cursor === null ? 0 : Number(cursor);
    const end = Math.min(offset + pageSize, total);
    return {
      items: Array.from({ length: end - offset }, (_, index) => ({ creator_id: `creator-${offset + index + 1}` })),
      next_cursor: end < total ? String(end) : null
    };
  };
}

test("normal reads stop after one bounded page", async () => {
  const result = await paginate({ fetchPage: syntheticFetcher(169) });
  assert.equal(result.items.length, 100);
  assert.deepEqual(result.pagination, {
    complete: false,
    next_cursor: "100",
    pages_read: 1,
    page_size: 100
  });
});

test("explicit traversal supports 169, 1000, and 20000 creators", async () => {
  const cases = [
    { total: 169, maxPages: 2, pages: 2 },
    { total: 1_000, maxPages: 10, pages: 10 },
    { total: 20_000, maxPages: 200, pages: 200 }
  ];
  for (const sample of cases) {
    const result = await paginate({
      fetchPage: syntheticFetcher(sample.total),
      pageSize: 100,
      maxPages: sample.maxPages
    });
    assert.equal(result.items.length, sample.total);
    assert.equal(result.pagination.pages_read, sample.pages);
    assert.equal(result.pagination.complete, true);
    assert.equal(result.pagination.next_cursor, null);
  }
});

test("an unfinished bound returns a cursor without claiming completeness", async () => {
  const result = await paginate({
    fetchPage: syntheticFetcher(1_000),
    cursor: "200",
    pageSize: 100,
    maxPages: 3
  });
  assert.equal(result.items.length, 300);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.next_cursor, "500");
  assert.equal(result.pagination.pages_read, 3);
});

test("pagination rejects unbounded caller limits", async () => {
  await assert.rejects(
    paginate({ fetchPage: syntheticFetcher(1), maxPages: 201 }),
    /maxPages/
  );
  await assert.rejects(
    paginate({ fetchPage: syntheticFetcher(1), pageSize: 0 }),
    /pageSize/
  );
});
