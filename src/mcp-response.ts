import { errorPayload } from "./errors.js";

export function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          value,
          (_key, item: unknown) =>
            typeof item === "bigint" ? item.toString() : item,
          2,
        ),
      },
    ],
  };
}

export function errorResult(error: unknown) {
  return {
    isError: true,
    ...jsonResult(errorPayload(error)),
  };
}

export async function runTool(action: () => Promise<unknown> | unknown) {
  try {
    return jsonResult(await action());
  } catch (error) {
    return errorResult(error);
  }
}
