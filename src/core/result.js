/**
 * Minimal ok/err pair used at module boundaries where a failure is an expected
 * outcome rather than an exception — resolution misses, queue index errors.
 * Exceptions stay reserved for genuine faults.
 */

export function ok(value) {
    return { ok: true, value };
}

export function err(error) {
    return { ok: false, error };
}

export function isOk(result) {
    return result?.ok === true;
}

export function isErr(result) {
    return result?.ok === false;
}

/** Returns the value or throws the carried error. Use only where throwing is correct. */
export function unwrap(result) {
    if (isOk(result)) return result.value;
    throw result?.error ?? new Error("unwrap called on a non-result");
}

/** Returns the value or a fallback. Use where a miss is survivable. */
export function unwrapOr(result, fallback) {
    return isOk(result) ? result.value : fallback;
}
