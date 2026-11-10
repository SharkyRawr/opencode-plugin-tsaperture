export const customModelAliases = [
  "weights-org/Model-V1",
  "weights-org/model-v1",
  "model-v1",
  "model",
  "publisher/model",
  "publisher/model-v1",
];

const canonical = {
  id: "current",
  name: "Model V1",
  canonical_model_id: "publisher/model-v1",
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
  tool_call: true,
  temperature: true,
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 64000, output: 4096 },
  cost: { input: 1, output: 2 },
};

export const customProviderCatalog = {
  publisher: {
    id: "publisher",
    name: "Publisher",
    models: {
      current: canonical,
      model: { ...canonical, id: "model", status: "deprecated" },
    },
  },
  "host-a": {
    id: "host-a",
    name: "Host A",
    models: Object.fromEntries(
      customModelAliases.map((id) => [
        id,
        {
          ...canonical,
          id,
          reasoning_options: [{ type: "effort", values: ["high", "extreme"] }],
          cost: { input: 10, output: 20 },
          status: "beta",
        },
      ]),
    ),
  },
  "host-b": {
    id: "host-b",
    name: "Host B",
    models: {
      "weights-org/model-v1": {
        ...canonical,
        id: "weights-org/model-v1",
        cost: { input: 30, output: 40 },
      },
    },
  },
};
