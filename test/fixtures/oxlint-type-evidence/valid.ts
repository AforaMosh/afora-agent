type User = { id: string };
type UsefulBoundary = { value: unknown };

const preserved = { id: "user-1" } satisfies User;
const preservedUser: User = preserved;

function preserveObjectType<Value extends object>(value: Value): Value {
  return value;
}

function parseBoundary(value: unknown): User | undefined {
  if (typeof value !== "object" || value === null || !("id" in value)) {
    return undefined;
  }
  return typeof value.id === "string" ? { id: value.id } : undefined;
}

export { parseBoundary, preserveObjectType, preservedUser, type UsefulBoundary };
