type DirectUnknown = unknown;
type ParenthesizedUnknown = unknown;
type IndirectUnknown = DirectUnknown;

type GenericAlias<T> = T;
type ConcreteAlias = GenericAlias<unknown>;
type UsefulBoundary = { value: unknown };
