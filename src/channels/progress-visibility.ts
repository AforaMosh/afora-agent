type ProgressVisibilityCallbackResult = boolean | void | Promise<boolean | void>;

export async function settleProgressVisibilityCallbackResult(
  callbackResult: ProgressVisibilityCallbackResult,
): Promise<{ result: boolean | void; visible: boolean }> {
  // Synchronous void is the legacy immediate-render contract. Promises must
  // report acceptance explicitly so queued async work cannot cancel a receipt.
  const result = callbackResult === undefined ? undefined : await callbackResult;
  return {
    result,
    visible: callbackResult === undefined || result === true,
  };
}
