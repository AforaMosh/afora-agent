import { AFORA_TAB_GROUP_TITLE } from "./relay-core.js";

export async function findAforaGroups() {
  try {
    return await chrome.tabGroups.query({ title: AFORA_TAB_GROUP_TITLE });
  } catch {
    return [];
  }
}

async function isAforaGroupId(groupId) {
  if (!Number.isInteger(groupId) || groupId < 0) {
    return false;
  }
  try {
    const group = await chrome.tabGroups.get(groupId);
    return group.title === AFORA_TAB_GROUP_TITLE;
  } catch {
    return false;
  }
}

export async function isTabSelected(tab) {
  return await isAforaGroupId(tab?.groupId);
}
