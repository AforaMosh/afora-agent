//#region src/index.ts
var LibterminalError = class extends Error {
	code;
	cause;
	constructor(code, message, options) {
		super(message);
		this.name = "LibterminalError";
		this.code = code;
		this.cause = options?.cause;
	}
};
function assertTerminalSize(size) {
	if (!Number.isSafeInteger(size.columns) || !Number.isSafeInteger(size.rows) || size.columns < 1 || size.rows < 1 || size.columns > 65535 || size.rows > 65535) throw new LibterminalError("invalid_terminal_size", `terminal size must be integer columns and rows between 1 and 65535`);
	return size;
}
//#endregion
export { LibterminalError, assertTerminalSize };
