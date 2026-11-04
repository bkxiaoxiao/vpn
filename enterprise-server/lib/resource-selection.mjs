import { fail } from "./security.mjs";

// Explicit selection is closed: a subscription refresh never grants newly added nodes.
// Legacy sourceIds retain their existing whole-subscription behavior until edited.
export function poolNodes(pool, resources, vault) {
  const selections = Array.isArray(pool.nodeSelections)
    ? pool.nodeSelections
    : (pool.sourceIds || []).map((resourceId) => ({ resourceId, all: true }));
  return selections.flatMap((selection) => {
    const resource = resources.find((r) => r.id === selection.resourceId);
    if (!resource) return [];
    return vault.open(resource.encrypted).nodes
      .filter((node) => selection.all || selection.nodeIds.includes(node.id))
      .map((node) => ({ ...node, resourceId: resource.id }));
  });
}

export function validateSelections(input, resources, vault) {
  if (!Array.isArray(input) || input.length > resources.length)
    fail("节点选择格式无效");
  const seen = new Set();
  return input.map((selection) => {
    const resource = resources.find((r) => r.id === selection?.resourceId);
    if (!resource || seen.has(resource.id)) fail("资源不存在或重复");
    seen.add(resource.id);
    if (!Array.isArray(selection.nodeIds) || !selection.nodeIds.length)
      fail("请为所选来源选择节点");
    const nodeIds = [...new Set(selection.nodeIds)];
    const available = new Set(vault.open(resource.encrypted).nodes.map((n) => n.id));
    if (nodeIds.some((nodeId) => !available.has(nodeId)))
      fail("所选节点已更新或不存在，请刷新后重新选择", 409);
    return { resourceId: resource.id, nodeIds };
  });
}
