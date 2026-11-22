export const PROMPT_PROCESSOR_NODE_TYPE =
  "Assets Astral Prompt Processor";

export const MUTED_NODE_MODE = 2;
export const BYPASS_NODE_MODE = 4;

function isDisabledNode(node) {
  return (
    node?.mode === MUTED_NODE_MODE ||
    node?.mode === BYPASS_NODE_MODE
  );
}

function isPromptProcessorNode(node) {
  return Boolean(
    node &&
      (node.type === PROMPT_PROCESSOR_NODE_TYPE ||
        node.comfyClass === PROMPT_PROCESSOR_NODE_TYPE ||
        node.constructor?.comfyClass === PROMPT_PROCESSOR_NODE_TYPE),
  );
}

function userPromptValue(node) {
  const widget = node?.widgets?.find(
    (candidate) => candidate?.name === "user_prompt",
  );
  return typeof widget?.value === "string" ? widget.value : "";
}

function userPromptPassthroughValue(graph, node) {
  const input = node?.inputs?.find(
    (candidate) => candidate?.name === "user_prompt",
  );
  const inputLink =
    input?.link && typeof input.link === "object"
      ? input.link
      : linkById(graph, input?.link);
  if (
    inputLink?.origin_id != null &&
    inputLink?.origin_slot != null
  ) {
    return [
      String(inputLink.origin_id),
      Number(inputLink.origin_slot),
    ];
  }
  return userPromptValue(node);
}

function graphNodes(graph) {
  const nodes = [
    ...(Array.isArray(graph?._nodes) ? graph._nodes : []),
    ...(Array.isArray(graph?.getNodes?.()) ? graph.getNodes() : []),
  ];
  const byId = graph?._nodes_by_id;
  if (byId instanceof Map) nodes.push(...byId.values());
  else if (byId && typeof byId === "object") {
    nodes.push(...Object.values(byId));
  }
  return [...new Set(nodes.filter(Boolean))];
}

function nodeById(graph, id) {
  const key = String(id);
  const direct =
    graph?.getNodeById?.(id) ||
    graph?.getNodeById?.(key) ||
    graph?._nodes_by_id?.[key];
  if (direct) return direct;
  return graphNodes(graph).find(
    (node) => String(node.id) === key,
  ) || null;
}

function linkById(graph, id) {
  if (id == null) return null;
  if (typeof id === "object") {
    id = id.id ?? id.link_id ?? null;
    if (id == null) return null;
  }
  const keys = [id, String(id)];
  const numericId = Number(id);
  if (Number.isFinite(numericId)) keys.push(numericId);

  const links = graph?.links;
  if (links instanceof Map) {
    for (const key of keys) {
      const link = links.get(key);
      if (link) return link;
    }
  }
  if (Array.isArray(links)) {
    const link = links.find(
      (candidate) => String(candidate?.id) === String(id),
    );
    if (link) return link;
  } else if (links && typeof links === "object") {
    for (const key of keys) {
      if (links[key]) return links[key];
    }
  }
  if (typeof graph?.getLink === "function") {
    for (const key of keys) {
      const link = graph.getLink(key);
      if (link) return link;
    }
  }
  return null;
}

function outputLinkIds(graph, node, slot) {
  const ids = [];
  const slotLinks = node?.outputs?.[slot]?.links || [];
  for (const entry of slotLinks) {
    if (entry && typeof entry === "object") {
      ids.push(entry.id ?? linkById(graph, entry.link_id)?.id);
    } else {
      ids.push(entry);
    }
  }
  const links = graph?.links;
  const values =
    links instanceof Map
      ? [...links.values()]
      : Array.isArray(links)
        ? links
        : Object.values(links || {});
  for (const link of values) {
    if (
      link &&
      String(link.origin_id) === String(node.id) &&
      Number(link.origin_slot) === Number(slot)
    ) {
      ids.push(link.id);
    }
  }
  return [...new Set(ids.filter((id) => id != null).map(String))];
}

function shouldFollowThrough(targetNode, promptNode) {
  return Boolean(
    targetNode &&
      !promptNode &&
      (targetNode.type === "Reroute" ||
        targetNode.isVirtualNode ||
        targetNode.mode === BYPASS_NODE_MODE),
  );
}

function applyLink(
  result,
  graph,
  link,
  promptValue,
  visitedLinks,
) {
  if (!link) return;
  const linkKey = String(link.id);
  if (visitedLinks.has(linkKey)) return;
  visitedLinks.add(linkKey);

  const targetNode = nodeById(graph, link.target_id);
  const promptNode = result?.output?.[String(link.target_id)];
  const targetInput =
    targetNode?.inputs?.[Number(link.target_slot)];
  if (promptNode?.inputs && targetInput?.name) {
    promptNode.inputs[targetInput.name] = promptValue;
    return;
  }
  if (!shouldFollowThrough(targetNode, promptNode)) return;
  for (
    let slot = 0;
    slot < (targetNode.outputs?.length || 0);
    slot += 1
  ) {
    for (const nextLinkId of outputLinkIds(graph, targetNode, slot)) {
      applyLink(
        result,
        graph,
        linkById(graph, nextLinkId),
        promptValue,
        visitedLinks,
      );
    }
  }
}

export function applyPromptProcessorPassthrough(result, graph) {
  if (!result?.output || !graph) return result;
  for (const node of graphNodes(graph)) {
    if (!isPromptProcessorNode(node) || !isDisabledNode(node)) {
      continue;
    }
    const promptValue = userPromptPassthroughValue(graph, node);
    const visitedLinks = new Set();
    for (
      let slot = 0;
      slot < (node.outputs?.length || 0);
      slot += 1
    ) {
      for (const linkId of outputLinkIds(graph, node, slot)) {
        applyLink(
          result,
          graph,
          linkById(graph, linkId),
          promptValue,
          visitedLinks,
        );
      }
    }
  }
  return result;
}
