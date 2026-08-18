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

		const CLASS = "dshgui-shell-status";

		/** Small status line contributed to the engine's own sidebar. */
		function ShellStatus() {
			return jsx.jsxs("div", {
				className: CLASS,
				children: [
					jsx.jsx("span", { className: `${CLASS}-dot` }),
					jsx.jsx("span", { className: `${CLASS}-text`, children: "Dsh GUI" }),
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
					padding: 4px 8px; border-radius: 6px;
					font-size: 11px; line-height: 1.4;
					color: var(--dsw-alias-text-3, #81858c);
				}
				.${CLASS}-dot {
					width: 6px; height: 6px; border-radius: 50%;
					background: var(--dsw-alias-brand-primary, #4176e6);
					flex: none;
				}
				.${CLASS}-text { white-space: nowrap; }
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
		return module.exports;
	},
});
