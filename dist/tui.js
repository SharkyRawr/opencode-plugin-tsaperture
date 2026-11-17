import { discoveryStatus } from "./discovery-status.js";
export default {
    id: discoveryStatus.id,
    // V1 delivers notifications through its server hook.
    tui: async () => { },
    async setup(context) {
        try {
            const message = await context.client
                .rpc(discoveryStatus)
                .startupError(null, {
                location: context.location,
            });
            if (typeof message === "string") {
                context.ui.toast.show({
                    title: "Tailscale Aperture",
                    message,
                    variant: "error",
                    duration: 10_000,
                });
            }
        }
        catch (error) {
            console.warn("[TailscaleAperture] Failed to read discovery status:", error);
        }
    },
};
//# sourceMappingURL=tui.js.map