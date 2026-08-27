// Runs test-projects serially with a one-worker Vitest budget.
process.env.AFORA_TEST_PROJECTS_SERIAL = "1";
process.env.AFORA_VITEST_MAX_WORKERS = "1";

await import("./test-projects.mts");
