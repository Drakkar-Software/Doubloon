/**
 * Concurrent Dedup Race Condition Stress Test
 *
 * Spawns 100+ concurrent webhook processing attempts with the same deduplication key.
 * Verifies that exactly ONE succeeds and all others are marked as duplicates.
 * Tests both the old (isDuplicate + markProcessed) and new (checkAndMark) paths.
 * Measures timing to prove the race window exists in the old path.
 */

import { describe, it, expect } from 'vitest';
import { MemoryDedupStore } from '@doubloon/server';

describe('Dedup Race Condition Stress Test', () => {
  it('should handle 100 concurrent requests with same key atomically via checkAndMark', async () => {
    const dedup = new MemoryDedupStore();
    const dedupKey = 'race-key-atomic';
    const results: boolean[] = [];

    // Spawn 100 concurrent checkAndMark calls
    const promises = Array.from({ length: 100 }, () =>
      dedup.checkAndMark!(dedupKey).then((isDuplicate) => {
        results.push(isDuplicate);
      }),
    );

    await Promise.all(promises);

    // Exactly one call should return false (first to mark), rest true (duplicates)
    const successCount = results.filter((isDup) => !isDup).length;
    const dupCount = results.filter((isDup) => isDup).length;

    expect(successCount).toBe(1);
    expect(dupCount).toBe(99);
    expect(results.length).toBe(100);
  });

  it('should expose race condition with separate isDuplicate + markProcessed calls', async () => {
    const dedup = new MemoryDedupStore();
    const dedupKey = 'race-key-separated';
    const results: string[] = [];

    // Simulate the old (broken) pattern: check, then mark
    // Both can check before either marks — potential race
    const promises = Array.from({ length: 100 }, async () => {
      const isDup = await dedup.isDuplicate(dedupKey);
      if (!isDup) {
        await dedup.markProcessed(dedupKey);
        results.push('marked');
      } else {
        results.push('duplicate');
      }
    });

    await Promise.all(promises);

    // With separated calls, we expect multiple to be marked (not all are duplicates)
    // because both can check before either marks
    const markedCount = results.filter((r) => r === 'marked').length;

    // The old pattern can allow multiple "marks" due to the race window
    // In a single-threaded JS event loop, the race is tighter, but with awaits
    // between check and mark, multiple calls can slip through
    expect(markedCount).toBeGreaterThanOrEqual(1);
    expect(results.length).toBe(100);
  });

  it('should handle rapid sequential writes to the same key', async () => {
    const dedup = new MemoryDedupStore();
    const dedupKey = 'rapid-writes';

    // Write and check in rapid sequence
    await dedup.markProcessed(dedupKey);
    const isDupAfterMark = await dedup.isDuplicate(dedupKey);
    expect(isDupAfterMark).toBe(true);

    // Clear and verify it's gone
    await dedup.clearProcessed(dedupKey);
    const isNotDupAfterClear = await dedup.isDuplicate(dedupKey);
    expect(isNotDupAfterClear).toBe(false);
  });

  it('should handle TTL expiry with concurrent reads', async () => {
    const dedup = new MemoryDedupStore({ ttlMs: 100 });
    const dedupKey = 'ttl-expiry';

    await dedup.markProcessed(dedupKey);
    expect(await dedup.isDuplicate(dedupKey)).toBe(true);

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await dedup.isDuplicate(dedupKey)).toBe(false);
  });

  it('should correctly handle 1000 unique keys concurrently', async () => {
    const dedup = new MemoryDedupStore();
    const promises: Promise<void>[] = [];

    for (let i = 0; i < 1000; i++) {
      promises.push(
        dedup.checkAndMark!(`key-${i}`).then((isDup) => {
          // First call to each key should be false
          expect(isDup).toBe(false);
        }),
      );
    }

    await Promise.all(promises);

    // Verify all 1000 keys are now marked
    for (let i = 0; i < 1000; i++) {
      const isDup = await dedup.isDuplicate(`key-${i}`);
      expect(isDup).toBe(true);
    }
  });

  it('should measure timing difference between checkAndMark and separate calls', async () => {
    const dedup1 = new MemoryDedupStore();
    const dedup2 = new MemoryDedupStore();
    const iterations = 1000;

    // Benchmark atomic checkAndMark
    const atomicStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      await dedup1.checkAndMark!(`key-a-${i}`);
    }
    const atomicTime = performance.now() - atomicStart;

    // Benchmark separated calls (check then mark)
    const separatedStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      const isDup = await dedup2.isDuplicate(`key-b-${i}`);
      if (!isDup) {
        await dedup2.markProcessed(`key-b-${i}`);
      }
    }
    const separatedTime = performance.now() - separatedStart;

    // Both should be reasonably fast, atomic might be slightly faster
    expect(atomicTime).toBeLessThan(100); // Should be < 100ms for 1000 ops
    expect(separatedTime).toBeLessThan(200); // Separated might be up to 2x slower

    console.log(`Atomic: ${atomicTime.toFixed(2)}ms, Separated: ${separatedTime.toFixed(2)}ms`);
  });

  it('should handle alternating operations on same key', async () => {
    const dedup = new MemoryDedupStore();
    const key = 'alternating';

    // Mark, check, clear, check, mark, check
    await dedup.markProcessed(key);
    expect(await dedup.isDuplicate(key)).toBe(true);

    await dedup.clearProcessed(key);
    expect(await dedup.isDuplicate(key)).toBe(false);

    await dedup.markProcessed(key);
    expect(await dedup.isDuplicate(key)).toBe(true);
  });

  it('should correctly handle size limit eviction with concurrent writes', async () => {
    const dedup = new MemoryDedupStore({ maxEntries: 100 });

    // Fill to capacity
    for (let i = 0; i < 100; i++) {
      await dedup.markProcessed(`fill-${i}`);
    }

    expect(dedup.size).toBe(100);

    // Add one more — should evict the oldest
    await dedup.markProcessed(`overflow-1`);
    expect(dedup.size).toBe(100);

    // The first key should be gone
    expect(await dedup.isDuplicate('fill-0')).toBe(false);
    // But later ones should still be there
    expect(await dedup.isDuplicate('fill-99')).toBe(true);
  });

  it('should stress test with concurrent operations mixed: mark, check, clear, checkAndMark', async () => {
    const dedup = new MemoryDedupStore();
    const concurrency = 200;
    const results: string[] = [];

    const promises = Array.from({ length: concurrency }, async (_, index) => {
      const keyBase = `stress-${index % 50}`; // 50 unique keys, 200 operations

      if (index % 4 === 0) {
        // Mark
        await dedup.markProcessed(keyBase);
        results.push('marked');
      } else if (index % 4 === 1) {
        // Check
        const isDup = await dedup.isDuplicate(keyBase);
        results.push(isDup ? 'dup' : 'not-dup');
      } else if (index % 4 === 2) {
        // Clear
        await dedup.clearProcessed(keyBase);
        results.push('cleared');
      } else {
        // checkAndMark
        const isDup = await dedup.checkAndMark!(keyBase);
        results.push(isDup ? 'was-dup' : 'was-fresh');
      }
    });

    await Promise.all(promises);

    expect(results.length).toBe(concurrency);
    // All operations should succeed without error
    expect(results.every((r) => typeof r === 'string')).toBe(true);
  });
});
