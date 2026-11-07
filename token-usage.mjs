/** Fold App Server request counters into one DSH usage chunk for this turn.
 * `total` covers the thread; `last` covers its latest request. The first
 * notification may follow an arbitrarily long resumed thread. */
export function turnUsage() {
  const mapping = {inputTokens:'inputTokens',outputTokens:'outputTokens',totalTokens:'totalTokens',cachedInputTokens:'cacheReadTokens',cacheWriteInputTokens:'cacheWriteTokens',reasoningOutputTokens:'reasoningTokens'};
  const keys=Object.keys(mapping), required=['inputTokens','outputTokens'];
  let previous, sum, invalid=false;
  const count = value => Number.isSafeInteger(value) && value >= 0;
  return {
    observe(event) {
      if (invalid) return;
      const total=event?.total,last=event?.last;
      if (!total || !last || required.some(key=>!count(total[key]) || !count(last[key]))) { invalid=true;sum=undefined;return; }
      if (!previous) {
        sum=Object.fromEntries(keys.filter(key=>count(total[key])&&count(last[key])).map(key=>[key,last[key]]));
      } else {
        for (const key of Object.keys(sum)) {
          if (!count(total[key]) || !count(previous[key])) { if (required.includes(key)) {invalid=true;sum=undefined;return;} delete sum[key];continue; }
          if (total[key] < previous[key]) {invalid=true;sum=undefined;return;}
          sum[key]+=total[key]-previous[key];
        }
      }
      previous=total;
    },
    result() {
      if (!sum) return undefined;
      return Object.fromEntries(Object.entries(sum).map(([key,value])=>[mapping[key],value]));
    },
  };
}
