import { logJson } from "./shared.mjs";

const RETRY_DELAYS_MS = [75, 200];

function classifyD1Error(error) {
  const message = [error?.message, error?.cause?.message, error?.code].filter(Boolean).join(" ");
  const reference = message.match(/\be_[A-Za-z0-9_-]{12,100}\b/)?.[0] ?? null;
  let errorClass = "d1_unclassified";
  if (/SQLITE_(CONSTRAINT|MISMATCH|RANGE|MISUSE|READONLY|AUTH|CORRUPT|ERROR)(?:_\w+)?\b|constraint failed|no such (table|column)|has no column|syntax error|wrong number|D1_TYPE_ERROR|unsupported type|binding.*(invalid|missing)/i.test(message)) {
    errorClass = "d1_permanent";
  } else if (/SQLITE_(BUSY|LOCKED)(?:_\w+)?\b|database (?:is )?(?:locked|busy)|D1_(?:EXEC_)?ERROR:\s*(?:internal error|network connection lost|service (?:is )?unavailable)|overloaded|temporarily unavailable|(?:connection|network).*(?:reset|lost)|timed?\s*out|timeout/i.test(message)) {
    errorClass = "d1_transient";
  }
  return { error_class: errorClass, error_reference: reference };
}

export async function retryD1(operation, context, reconcile) {
  let uncertain = false;
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (uncertain) {
        const durableResult = await reconcile();
        if (durableResult !== undefined) return durableResult;
        uncertain = false;
      }
      try {
        return await operation();
      } catch (error) {
        uncertain = Boolean(reconcile);
        throw error;
      }
    } catch (error) {
      const details = classifyD1Error(error);
      const retry = details.error_class === "d1_transient" && attempt < RETRY_DELAYS_MS.length;
      logJson(context.scheduler_name, retry ? "scheduler_d1_retry" : "scheduler_d1_failed", {
        ...context,
        ...details,
        attempt: attempt + 1,
        write_outcome_unconfirmed: uncertain,
      });
      if (!retry) {
        const failure = new Error(details.error_class);
        Object.assign(failure, details);
        throw failure;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}
