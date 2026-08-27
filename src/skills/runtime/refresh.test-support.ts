import "./refresh.js";

type SkillsRefreshTestApi = {
  resetSkillsRefreshForTest(): Promise<void>;
};

function getTestApi(): SkillsRefreshTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("afora.skillsRefreshTestApi")
  ] as SkillsRefreshTestApi;
}

export async function resetSkillsRefreshForTest(): Promise<void> {
  await getTestApi().resetSkillsRefreshForTest();
}
