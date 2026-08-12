type User = { id: string };

const user: unknown = { id: "user-1" };
const assertedUser = user as User;

const original = { id: "user-2" };
const erased = original as unknown;
const restoredUser = erased as User;

const preserved = { id: "user-3" } satisfies User;
const preservedUser: User = preserved;

export { assertedUser, preservedUser, restoredUser };
