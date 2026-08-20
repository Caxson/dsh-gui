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
		const CLASS_A = "dshgui-shell-appearance";
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
			// The cap has to do the trimming, not CSS — `text-overflow` cuts the
			// end, which is the half worth keeping. CSS ellipsis stays only as a
			// backstop for a narrow window.
			return short.length > 24 ? "…" + short.slice(-23) : short;
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
				/* The footer row is one flex line ~256px wide, and everything in
				   it competes for that. So it is split by kind: what you press
				   sits left at a fixed size, what you read is pushed to the far
				   edge and takes whatever is left. Before this the workspace was
				   a plain flex item next to a full-width button and got squeezed
				   down to two characters — a status line that said "Ds…". */
				.${CLASS} {
					display: flex; align-items: center; gap: 6px;
					margin-left: auto; flex: 0 1 auto;
					min-width: 0; height: 26px; padding: 0 2px;
					/* A path is machine output: monospace, per DESIGN.md's data
					   role. The CJK fallback is explicit — a latin-only mono
					   would drop Chinese path segments to a different face. */
					font-family: "SF Mono", ui-monospace, Menlo, "PingFang SC", monospace;
					font-size: 10.5px; line-height: 26px;
					color: var(--dsw-alias-label-tertiary, #81858c);
				}
				.${CLASS}-text {
					min-width: 0; overflow: hidden;
					text-overflow: ellipsis; white-space: nowrap;
				}
				.${CLASS}-count {
					flex: none; padding: 0 5px; border-radius: 7px;
					background: var(--dsw-alias-brand-primary, #4176e6);
					color: #fff; font-size: 9.5px; font-weight: 600; line-height: 14px;
					font-family: "SF Mono", ui-monospace, Menlo, monospace;
					font-variant-numeric: tabular-nums;
				}

				/* Appearance. Every colour comes from the engine's own tokens, which
				   our theme sheet already overrides — so this control is themed by
				   the very thing it switches. */
				.${CLASS_A}-wrap { position: relative; display: flex; }
				.${CLASS_A}-btn {
					display: flex; align-items: center; justify-content: center;
					width: 26px; height: 26px; padding: 0;
					border: 0; border-radius: 6px; background: transparent;
					color: var(--dsw-alias-label-tertiary, #adb2b8); cursor: pointer;
				}
				.${CLASS_A}-btn:hover {
					background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08));
					color: var(--dsw-alias-label-primary, #ebeef2);
				}
				.${CLASS_A}-menu {
					position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 50;
					min-width: 190px; max-height: 320px; overflow-y: auto;
					padding: 4px; border-radius: 8px;
					background: var(--dsw-specific-menu, #353638);
					border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.13));
					box-shadow: 0 10px 28px rgba(0,0,0,.34);
				}
				.${CLASS_A}-item {
					display: flex; align-items: baseline; gap: 8px; width: 100%;
					padding: 6px 9px; border: 0; border-radius: 5px;
					background: transparent; cursor: pointer; text-align: left;
					color: var(--dsw-alias-label-primary, #ebeef2); font-size: 12px;
				}
				.${CLASS_A}-item:hover {
					background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08));
				}
				.${CLASS_A}-item.on { color: var(--dsw-alias-brand-text, #4176e6); }
				.${CLASS_A}-name { flex: 1; min-width: 0; }
				.${CLASS_A}-note {
					flex: none; font-size: 10px;
					color: var(--dsw-alias-label-tertiary, #81858c);
				}
			`;
			document.head.appendChild(style);
		}

		/**
		 * Appearance, in the sidebar's footer.
		 *
		 * It used to live in the right panel's header — which is collapsed by
		 * default, so the only way to reach the ten themes the app ships was to
		 * open a panel you had no reason to open. The sidebar footer is the one
		 * place always on screen.
		 *
		 * `dshGuiHost` is the desktop app's preload. Outside the app — this
		 * plugin also loads in a plain browser — it is absent and the control
		 * renders nothing rather than a button that cannot work.
		 */
		function ShellAppearance() {
			const host = typeof window !== "undefined" ? window.dshGuiHost : null;
			const [open, setOpen] = React.useState(false);
			const [data, setData] = React.useState(null);

			const load = React.useCallback(async () => {
				if (!host) return;
				try {
					setData(await host.themes());
				} catch {
					setData(null);
				}
			}, [host]);

			React.useEffect(() => {
				if (!host) return undefined;
				load();
				// Follow changes made anywhere else — the panel's own picker, or
				// the system flipping to dark at sunset.
				host.onHostState(() => load());
				const dismiss = () => setOpen(false);
				window.addEventListener("click", dismiss);
				return () => window.removeEventListener("click", dismiss);
			}, [host, load]);

			if (!host) return null;

			const choose = async (id) => {
				setOpen(false);
				await host.setTheme(id);
				load();
			};

			const themes = (data && data.themes) || [];
			const house = data && data.house;
			const current = data && data.current;
			const following = data && data.following;

			const item = (id, label, note, on) =>
				jsx.jsxs("button", {
					className: `${CLASS_A}-item${on ? " on" : ""}`,
					onClick: (e) => { e.stopPropagation(); choose(id); },
					children: [
						jsx.jsx("span", { className: `${CLASS_A}-name`, children: label }),
						note ? jsx.jsx("span", { className: `${CLASS_A}-note`, children: note }) : null,
					],
				});

			return jsx.jsxs("div", {
				className: `${CLASS_A}-wrap`,
				children: [
					jsx.jsx("button", {
						className: `${CLASS_A}-btn`,
						title: "外观",
						"aria-label": "外观",
						onClick: (e) => { e.stopPropagation(); setOpen(!open); },
						children: jsx.jsxs("svg", {
							width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true",
							children: [
								jsx.jsx("circle", { cx: 8, cy: 8, r: 5.3, stroke: "currentColor", strokeWidth: 1.4 }),
								jsx.jsx("path", { d: "M8 2.7a5.3 5.3 0 0 1 0 10.6z", fill: "currentColor" }),
							],
						}),
					}),
					open
						? jsx.jsxs("div", {
								className: `${CLASS_A}-menu`,
								onClick: (e) => e.stopPropagation(),
								children: [
									house ? item(house.follow, "跟随系统", "深色 / 浅色", following === true) : null,
									...themes.map((t) =>
										item(t.id, t.name, t.author || "", !following && t.id === current),
									),
								],
						  })
						: null,
				],
			});
		}

		function apply(ctx) {
			injectStyle();
			// inject() waits for the slot's host to exist. Registering into a
			// slot nobody renders is a silent no-op — measured: several slot
			// names accept a registration and never show it, because their host
			// only mounts in some views.
			ctx.slots.inject("sidebar.footer.action", () => {
				// Last in the row, and it pushes itself to the far edge: actions
				// on the left, the thing you only read on the right.
				ctx.slots.register(
					{ name: "sidebar.footer.action", id: "dsh-gui-status", order: 90 },
					ShellStatus,
				);
				// Lower order so appearance sits at the far left of the footer,
				// where the window's other bottom-left controls already are.
				ctx.slots.register(
					{ name: "sidebar.footer.action", id: "dsh-gui-appearance", order: 10 },
					ShellAppearance,
				);
			});
		}

		// The runtime refuses `ctx.slots` unless the plugin declares it here:
		// services are opt-in, and without this the entry fails to load with
		// "cannot get property slots without inject".
		const inject = ["slots"];

		exports.inject = inject;
		exports.apply = apply;
		exports.ShellStatus = ShellStatus;
		exports.ShellAppearance = ShellAppearance;
		exports.countChangedFiles = countChangedFiles;
		return module.exports;
	},
});
