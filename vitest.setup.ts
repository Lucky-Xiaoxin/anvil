/**
 * 单测禁真实网络（技术锁）：把 `fetch` stub 成一个抛错的替身。
 * 所有 client 都应注入 `fetchImpl`；若某条测试因此转红，说明它真的在打网络 —— 修它，别绕过。
 */
import { vi } from 'vitest';

vi.stubGlobal('fetch', () => {
  throw new Error('单测禁止真实网络（技术锁）：请注入 fetchImpl');
});