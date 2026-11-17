export const discoveryStatus = {
  id: "opencode-plugin-tsaperture",
  methods: {
    startupError: {
      input: { type: "null" },
      output: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  },
  events: {},
} as const;
