import { createHash } from "node:crypto";

import { ToolError } from "../contracts/errors.ts";
import {
  prepareMutation,
  type NativeMutationExecutor,
  type NativeMutationReceipt,
  type PreparedMutation,
} from "../platform/native-mutation-executor.ts";
import {
  decodeWindowsMutationPlan,
  encodeWindowsMutationPlan,
  type WindowsMutationPlan,
} from "./windows-mutation-plan.ts";

export interface AdmittedWindowsMutationPlan {
  readonly plan: WindowsMutationPlan;
  readonly bytes: Uint8Array;
  readonly mutation: PreparedMutation;
  readonly receipt: NativeMutationReceipt;
}

function failure(actual: string): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "Windows mutation authority rejected the plan", {
    field: "update.windowsMutationPlan",
    expected: "one reserved and admitted fixed-slot plan bound to the live executor epoch",
    actual,
    safeNextStep: "Preserve the installation journal and run self-update repair.",
  });
}

/**
 * Binds a canonical path-free plan to the native fixed transaction slot.
 * The caller must still cross-check the plan against the outer journal and
 * authenticated release before invoking this function.
 */
export async function admitWindowsMutationPlan(
  executor: NativeMutationExecutor,
  plan: WindowsMutationPlan,
): Promise<AdmittedWindowsMutationPlan> {
  if (executor === null || typeof executor !== "object" || typeof executor.reserve !== "function" ||
      typeof executor.admit !== "function" || typeof executor.revoke !== "function") {
    throw failure("executor-unavailable");
  }
  const bytes = encodeWindowsMutationPlan(plan);
  const checkedPlan = decodeWindowsMutationPlan(bytes);
  const mutation = prepareMutation(bytes);
  let reserved = false;
  try {
    await executor.reserve(mutation);
    reserved = true;
    const receipt = await executor.admit(mutation);
    if (receipt.slot !== "transaction" || receipt.operationId !== mutation.operationId ||
        receipt.epochId !== executor.epoch.attemptId || !Number.isSafeInteger(receipt.operationSequence) ||
        receipt.operationSequence < 1 || receipt.bytesSha256 !== mutationDigest(mutation)) {
      throw failure("receipt-does-not-bind-plan");
    }
    return Object.freeze({ plan: checkedPlan, bytes: Uint8Array.from(bytes), mutation, receipt });
  } catch (error) {
    if (reserved) await executor.revoke(mutation).catch(() => undefined);
    throw error instanceof ToolError ? error : failure("native-admission-failed");
  }
}

function mutationDigest(mutation: PreparedMutation): string {
  return createHash("sha256").update(mutation.bytes).digest("hex");
}
