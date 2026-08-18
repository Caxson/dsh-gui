window.__ModuleLoader__.load({
	id: "dsh-gui-shell",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// Written by hand in the shape the engine's own client bundles use:
		// register a factory with the module loader, require what the runtime
		// already registered, hand components to slots. No bundler, so an
		// engine upgrade cannot break a build step we would otherwise own.
		//
		// This is the supported way to add UI. Restyling the engine's markup is
		// not: its class names are content hashed and change with every
		// release, while a slot is a published contract.
		const jsx = require("react/jsx-runtime");
		const React = require("react");

		const CLASS = "dshgui-shell-status";
		// The desktop bridge already serves this, and a client plugin runs on
		// the same origin as the engine — so what is shown below is the app's
		// real state, not a decorative figure.
		const STATE_URL = "/dsh-gui/state";
		const POLL_MS = 2000;

		/** Distinct files the agent has touched, from the bridge's activity log. */
		function countChangedFiles(state) {
			const paths = new Set();
			for (const a of (state && state.activities) || []) {
				if (a && a.kind === "file" && a.path) paths.add(a.path);
			}
			return paths.size;
		}

		function shortenPath(path, home) {
			if (typeof path !== "string") return "";
			const short = home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
			// Keep the tail: the end of a path identifies it, the start repeats.
			return short.length > 34 ? "…" + short.slice(-33) : short;
		}

		/**
		 * A live line in the engine's own sidebar: which workspace is in play,
		 * and how much the agent has changed in it.
		 */
		function ShellStatus() {
			const [state, setState] = React.useState(null);
			const [reachable, setReachable] = React.useState(true);

			React.useEffect(() => {
				let stopped = false;
				let timer = null;
				const tick = async () => {
					try {
						const res = await fetch(STATE_URL, { cache: "no-store" });
						if (!res.ok) throw new Error("HTTP " + res.status);
						const next = await res.json();
						if (!stopped) {
							setState(next);
							setReachable(true);
						}
					} catch {
						// The bridge only exists inside the desktop app. Opened in
						// a plain browser this renders nothing, rather than showing
						// a broken widget or retrying loudly forever.
						if (!stopped) setReachable(false);
					}
					if (!stopped) timer = setTimeout(tick, POLL_MS);
				};
				tick();
				return () => {
					stopped = true;
					if (timer) clearTimeout(timer);
				};
			}, []);

			if (!reachable) return null;

			const changed = countChangedFiles(state);
			const workspace = shortenPath(state && state.cwd, state && state.home);

			return jsx.jsxs("div", {
				className: CLASS,
				title: (state && state.cwd) || "",
				children: [
					jsx.jsx("span", { className: `${CLASS}-dot` }),
					jsx.jsx("span", { className: `${CLASS}-text`, children: workspace || "Dsh GUI" }),
					changed > 0
						? jsx.jsx("span", { className: `${CLASS}-count`, children: String(changed) })
						: null,
				],
			});
		}

		/**
		 * Styles ship with the component. Scoped to our own class names — the
		 * engine's are hashed, so anything keyed to them would break, and
		 * anything unscoped would leak into the engine's UI.
		 */
		function injectStyle() {
			const id = "dshgui-shell-style";
			if (document.getElementById(id)) return;
			const style = document.createElement("style");
			style.id = id;
			style.textContent = `
				.${CLASS} {
					display: flex; align-items: center; gap: 6px;
					min-width: 0; padding: 4px 8px; border-radius: 6px;
					font-size: 11px; line-height: 1.4;
					color: var(--dsw-alias-text-3, #81858c);
				}
				.${CLASS}-dot {
					width: 6px; height: 6px; border-radius: 50%;
					background: var(--dsw-alias-brand-primary, #4176e6);
					flex: none;
				}
				.${CLASS}-text {
					min-width: 0; overflow: hidden;
					text-overflow: ellipsis; white-space: nowrap;
				}
				.${CLASS}-count {
					flex: none; padding: 0 5px; border-radius: 7px;
					background: var(--dsw-alias-brand-primary, #4176e6);
					color: #fff; font-size: 9.5px; font-weight: 600; line-height: 14px;
				}
			`;
			document.head.appendChild(style);
		}

		function apply(ctx) {
			injectStyle();
			// inject() waits for the slot's host to exist. Registering into a
			// slot nobody renders is a silent no-op — measured: several slot
			// names accept a registration and never show it, because their host
			// only mounts in some views.
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{ name: "sidebar.footer.action", id: "dsh-gui-status", order: 20 },
					ShellStatus,
				),
			);
		}

		// The runtime refuses `ctx.slots` unless the plugin declares it here:
		// services are opt-in, and without this the entry fails to load with
		// "cannot get property slots without inject".
		const inject = ["slots"];

		exports.inject = inject;
		exports.apply = apply;
		exports.ShellStatus = ShellStatus;
		exports.countChangedFiles = countChangedFiles;
		return module.exports;
	},
});
