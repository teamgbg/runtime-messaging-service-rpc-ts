/**
 * @system runtime-auth-flow
 * @status handwritten
 */

import { getAppLogger } from "@teamscala/logger/app-loggers";
import { getMessagingServiceUrl, getTelegramAdapterKey } from "@teamscala/runtime-auth-flow-config/configure";
import { errMsg } from "@teamscala/runtime-auth-flow-config/err-msg";

const MESSAGING_SERVICE_URL = getMessagingServiceUrl();
// The telegram-connect endpoints are gated by @teamscala/telegram's X-API-Key check
// (TELEGRAM_ADAPTER_KEY) — NOT api-key-auth. Send the telegram surface's
// dedicated key ONLY; no SCALA_DEV_KEY fallback (internal-auth-credentials-decomposed).
const internalKey = getTelegramAdapterKey();

export type TelegramConnectStep = "start" | "phone" | "code" | "password" | "qr";

export interface MessagingRpcResult {
	ok: boolean;
	/** Auth status returned by the messaging service ("waiting_code"/"waiting_qr"/"ready"/…). */
	status: string;
	error?: string;
	httpStatus: number;
	/** tg://login QR link — present on the "qr" connect step and on status while waiting_qr. */
	qrLink?: string;
}

function serviceHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (internalKey) headers["X-API-Key"] = internalKey;
	return headers;
}

/** POST one connect step to the messaging service; returns the resulting auth status. */
export async function callMessagingConnect(
	step: TelegramConnectStep,
	body: Record<string, unknown>,
	timeoutMs = 15_000,
): Promise<MessagingRpcResult> {
	if (!MESSAGING_SERVICE_URL) {
		getAppLogger().error("[telegram-connect] MESSAGING_SERVICE_URL not configured");
		return { ok: false, status: "error", error: "MESSAGING_SERVICE_URL not configured", httpStatus: 500 };
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${MESSAGING_SERVICE_URL}/api/telegram/connect/${step}`, {
			method: "POST",
			headers: serviceHeaders(),
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		const status = typeof data.status === "string" ? data.status : "error";
		const error = typeof data.error === "string" ? data.error : undefined;
		// Extract qrLink — the messaging service returns it on the "qr" step
		// (status=waiting_qr). Without this, handleTelegramQrStep always falls back
		// to "QR login unavailable" + the phone form, even though TDLib produced a
		// valid tg://login token. Mirrors callMessagingStatus's qrLink handling.
		const qrLink = typeof data.qrLink === "string" ? data.qrLink : undefined;
		if (!response.ok) {
			getAppLogger().error(`[telegram-connect] ${step} ← ${response.status}`, { error });
		}
		return { ok: response.ok, status, error, httpStatus: response.status, qrLink };
	} catch (error) {
		getAppLogger().error(`[telegram-connect] ${step} failed`, {
			error: errMsg(error),
		});
		return { ok: false, status: "error", error: "Failed to reach messaging service", httpStatus: 502 };
	} finally {
		clearTimeout(timeout);
	}
}

/** GET the current auth status (polled by the QR page until "ready"). Carries qrLink when waiting. */
export async function callMessagingStatus(
	accountId: string,
): Promise<MessagingRpcResult & { qrLink?: string }> {
	if (!MESSAGING_SERVICE_URL) {
		getAppLogger().error("[telegram-connect] MESSAGING_SERVICE_URL not configured");
		return { ok: false, status: "error", error: "MESSAGING_SERVICE_URL not configured", httpStatus: 500 };
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const url = `${MESSAGING_SERVICE_URL}/api/telegram/connect/status?accountId=${encodeURIComponent(accountId)}`;
		const response = await fetch(url, {
			method: "GET",
			headers: serviceHeaders(),
			signal: controller.signal,
		});
		const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		const status = typeof data.status === "string" ? data.status : "error";
		const error = typeof data.error === "string" ? data.error : undefined;
		const qrLink = typeof data.qrLink === "string" ? data.qrLink : undefined;
		return { ok: response.ok, status, error, httpStatus: response.status, qrLink };
	} catch (error) {
		getAppLogger().error("[telegram-connect] status failed", {
			error: errMsg(error),
		});
		return { ok: false, status: "error", error: "Failed to reach messaging service", httpStatus: 502 };
	} finally {
		clearTimeout(timeout);
	}
}
