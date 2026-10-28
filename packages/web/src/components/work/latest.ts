/** 只让最后一次请求落地：begin() 领序号；响应回来用 isCurrent() 判；invalidate() 作废全部在途请求。 */
export interface LatestGate {
  begin(): number;
  isCurrent(token: number): boolean;
  invalidate(): void;
}

export function createLatestGate(): LatestGate {
  let seq = 0;
  return {
    begin: () => ++seq,
    isCurrent: (token) => token === seq,
    invalidate: () => {
      seq += 1;
    },
  };
}
