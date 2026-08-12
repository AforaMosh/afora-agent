type ObjectAlias = object;

function directObject(value: object): boolean {
  return value !== null;
}

function aliasedObject(value: ObjectAlias): boolean {
  return value !== null;
}

type ObjectCallback = (value: object) => boolean;

export { aliasedObject, directObject, type ObjectCallback };
