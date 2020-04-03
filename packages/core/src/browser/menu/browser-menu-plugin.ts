/********************************************************************************
 * Copyright (C) 2017 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { injectable, inject } from 'inversify';
import { MenuBar, Menu as MenuWidget, Widget } from '@phosphor/widgets';
import { CommandRegistry as PhosphorCommandRegistry } from '@phosphor/commands';
import {
    CommandRegistry, ActionMenuNode, CompositeMenuNode,
    MenuModelRegistry, MAIN_MENU_BAR, MenuPath, DisposableCollection, Disposable
} from '../../common';
import { KeybindingRegistry } from '../keybinding';
import { FrontendApplicationContribution, FrontendApplication } from '../frontend-application';
import { ContextKeyService } from '../context-key-service';
import { ContextMenuContext } from './context-menu-context';
import { waitForRevealed } from '../widgets';
import { ApplicationShell } from '../shell';

export abstract class MenuBarWidget extends MenuBar {
    abstract activateMenu(label: string, ...labels: string[]): Promise<MenuWidget>;
    abstract triggerMenuItem(label: string, ...labels: string[]): Promise<MenuWidget.IItem>;
}

@injectable()
export class BrowserMainMenuFactory {

    @inject(ContextKeyService)
    protected readonly contextKeyService: ContextKeyService;

    @inject(ContextMenuContext)
    protected readonly context: ContextMenuContext;

    @inject(CommandRegistry)
    protected readonly commandRegistry: CommandRegistry;

    @inject(KeybindingRegistry)
    protected readonly keybindingRegistry: KeybindingRegistry;

    @inject(MenuModelRegistry)
    protected readonly menuProvider: MenuModelRegistry;

    createMenuBar(): MenuBarWidget {
        const menuBar = new DynamicMenuBarWidget();
        menuBar.id = 'theia:menubar';
        this.fillMenuBar(menuBar);
        const listener = this.keybindingRegistry.onKeybindingsChanged(() => {
            menuBar.clearMenus();
            this.fillMenuBar(menuBar);
        });
        menuBar.disposed.connect(() => listener.dispose());
        return menuBar;
    }

    protected fillMenuBar(menuBar: MenuBarWidget): void {
        const menuModel = this.menuProvider.getMenu(MAIN_MENU_BAR);
        const menuCommandRegistry = this.createMenuCommandRegistry(menuModel);
        for (const menu of menuModel.children) {
            if (menu instanceof CompositeMenuNode) {
                const menuWidget = new DynamicMenuWidget(menu, { commands: menuCommandRegistry }, this.services);
                menuBar.addMenu(menuWidget);
            }
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createContextMenu(path: MenuPath, args?: any[]): MenuWidget {
        const menuModel = this.menuProvider.getMenu(path);
        const menuCommandRegistry = this.createMenuCommandRegistry(menuModel, args).use();
        const contextMenu = new DynamicMenuWidget(menuModel, { commands: menuCommandRegistry }, this.services);
        return contextMenu;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected createMenuCommandRegistry(menu: CompositeMenuNode, args: any[] = []): MenuCommandRegistry {
        const menuCommandRegistry = new MenuCommandRegistry(this.services);
        this.registerMenu(menuCommandRegistry, menu, args);
        return menuCommandRegistry;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected registerMenu(menuCommandRegistry: MenuCommandRegistry, menu: CompositeMenuNode, args: any[]): void {
        for (const child of menu.children) {
            if (child instanceof ActionMenuNode) {
                menuCommandRegistry.registerActionMenu(child, args);
                if (child.altNode) {
                    menuCommandRegistry.registerActionMenu(child.altNode, args);
                }
            } else if (child instanceof CompositeMenuNode) {
                this.registerMenu(menuCommandRegistry, child, args);
            }
        }
    }

    private get services(): MenuServices {
        return {
            context: this.context,
            contextKeyService: this.contextKeyService,
            commandRegistry: this.commandRegistry,
            keybindingRegistry: this.keybindingRegistry
        };
    }

}

class DynamicMenuBarWidget extends MenuBarWidget {

    constructor() {
        super();
        // HACK we need to hook in on private method _openChildMenu. Don't do this at home!
        DynamicMenuBarWidget.prototype['_openChildMenu'] = () => {
            if (this.activeMenu instanceof DynamicMenuWidget) {
                this.activeMenu.aboutToShow();
            }
            super['_openChildMenu']();
        };
    }

    async activateMenu(label: string, ...labels: string[]): Promise<MenuWidget> {
        const menu = this.menus.find(m => m.title.label === label);
        if (!menu) {
            throw new Error(`could not find '${label}' menu`);
        }
        this.activeMenu = menu;
        this.openActiveMenu();
        await waitForRevealed(menu);

        const menuPath = [label];

        let current = menu;
        for (const itemLabel of labels) {
            const item = current.items.find(i => i.label === itemLabel);
            if (!item || !item.submenu) {
                throw new Error(`could not find '${label}' submenu in ${menuPath.map(l => "'" + l + "'").join(' -> ')} menu`);
            }
            current.activeItem = item;
            current.triggerActiveItem();
            current = item.submenu;
            await waitForRevealed(current);
        }
        return current;
    }

    async triggerMenuItem(label: string, ...labels: string[]): Promise<MenuWidget.IItem> {
        if (!labels.length) {
            throw new Error('menu item label is not specified');
        }
        const menuPath = [label, ...labels.slice(0, labels.length - 1)];
        const menu = await this.activateMenu(menuPath[0], ...menuPath.slice(1));
        const item = menu.items.find(i => i.label === labels[labels.length - 1]);
        if (!item) {
            throw new Error(`could not find '${label}' item in ${menuPath.map(l => "'" + l + "'").join(' -> ')} menu`);
        }
        menu.activeItem = item;
        menu.triggerActiveItem();
        return item;
    }

}

class MenuServices {
    readonly commandRegistry: CommandRegistry;
    readonly keybindingRegistry: KeybindingRegistry;
    readonly contextKeyService: ContextKeyService;
    readonly context: ContextMenuContext;
}

/**
 * A menu widget that would recompute its items on update.
 */
class DynamicMenuWidget extends MenuWidget {

    /**
     * We want to restore the focus after the menu closes.
     */
    protected previousFocusedElement?: HTMLElement;

    constructor(
        protected menu: CompositeMenuNode,
        protected options: MenuWidget.IOptions & { commands: MenuCommandRegistry },
        protected services: MenuServices
    ) {
        super(options);
        if (menu.label) {
            this.title.label = menu.label;
        }
        if (menu.iconClass) {
            this.title.iconClass = menu.iconClass;
        }
        this.updateSubMenus(this, this.menu, this.options.commands);
    }

    public aboutToShow(): void {
        this.preserveFocusedElement();
        this.clearItems();
        this.runWithPreservedFocusElement(() => {
            this.options.commands.use();
            this.updateSubMenus(this, this.menu, this.options.commands);
        });
    }

    public open(x: number, y: number, options?: MenuWidget.IOpenOptions): void {
        const cb = () => {
            this.releaseFocusedElement();
            this.aboutToClose.disconnect(cb);
        };
        this.aboutToClose.connect(cb);
        super.open(x, y, options);
    }

    private updateSubMenus(parent: MenuWidget, menu: CompositeMenuNode, commands: MenuCommandRegistry): void {
        const items = this.buildSubMenus([], menu, commands);
        for (const item of items) {
            parent.addItem(item);
        }
    }

    private buildSubMenus(items: MenuWidget.IItemOptions[], menu: CompositeMenuNode, commands: MenuCommandRegistry): MenuWidget.IItemOptions[] {
        for (const item of menu.children) {
            if (item instanceof CompositeMenuNode) {
                if (item.children.length) { // do not render empty nodes
                    if (item.isSubmenu) { // submenu node
                        const submenu = new DynamicMenuWidget(item, this.options, this.services);
                        if (!submenu.items.length) {
                            continue;
                        }
                        items.push({
                            type: 'submenu',
                            submenu,
                        });
                    } else { // group node
                        const submenu = this.buildSubMenus([], item, commands);
                        if (!submenu.length) {
                            continue;
                        }
                        if (items.length) { // do not put a separator above the first group
                            items.push({
                                type: 'separator'
                            });
                        }
                        items.push(...submenu); // render children
                    }
                }
            } else if (item instanceof ActionMenuNode) {
                const { context, contextKeyService } = this.services;
                const node = item.altNode && context.altPressed ? item.altNode : item;
                const { when } = node.action;
                if (!(commands.isVisible(node.action.commandId) && (!when || contextKeyService.match(when)))) {
                    continue;
                }
                items.push({
                    command: node.action.commandId,
                    type: 'command'
                });
            }
        }
        return items;
    }

    /**
     * Preserves the "focused" HTML element (`document.activeElement`) so that we can restore focus right before:
     *  - executing the underlying command, or
     *  - when the command has not been executed, but the menu was closed (`Esc`, or click somewhere else).
     * Returns `true` if the active element has been preserved. Otherwise, `false`. Calling this method after preserving the
     * focused element is a NOOP.
     */
    protected preserveFocusedElement(): boolean {
        if (!this.previousFocusedElement) {
            const { activeElement } = window.document;
            if (activeElement instanceof HTMLElement) {
                this.previousFocusedElement = activeElement;
                return true;
            }
        }
        return false;
    }

    /**
     * Restores the focus on the previously preserved HTML element.
     * Has no effect, if the focus was already restored, or there was no preserved focused element.
     * `true` if the restoration was successful. Otherwise, `false`.
     */
    protected releaseFocusedElement(): boolean {
        if (this.previousFocusedElement) {
            this.previousFocusedElement.focus({ preventScroll: true });
            this.previousFocusedElement = undefined;
            return true;
        }
        return false;
    }

    /**
     * This method executes `what` with the following conditions:
     *  - Temporarily sets the focus on the `previousFocusedElement` so this context will be used for command handler calculation.
     *  - Runs `what`. `what` must be executed synchronously.
     *  - Sets back the focus on the original `activeElement`.
     */
    protected runWithPreservedFocusElement(what: () => void): void {
        let focusToRestore: HTMLElement | undefined = undefined;
        const { activeElement } = document;
        if (this.previousFocusedElement && activeElement instanceof HTMLElement && this.previousFocusedElement !== activeElement) {
            focusToRestore = activeElement;
            this.previousFocusedElement.focus({ preventScroll: true });
        }
        try {
            what();
        } finally {
            if (focusToRestore) {
                focusToRestore.focus({ preventScroll: true });
            }
        }
    }

}

@injectable()
export class BrowserMenuBarContribution implements FrontendApplicationContribution {

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    constructor(
        @inject(BrowserMainMenuFactory) protected readonly factory: BrowserMainMenuFactory
    ) { }

    onStart(app: FrontendApplication): void {
        const logo = this.createLogo();
        app.shell.addWidget(logo, { area: 'top' });
        const menu = this.factory.createMenuBar();
        app.shell.addWidget(menu, { area: 'top' });
    }

    get menuBar(): MenuBarWidget | undefined {
        return this.shell.topPanel.widgets.find(w => w instanceof MenuBarWidget) as MenuBarWidget | undefined;
    }

    protected createLogo(): Widget {
        const logo = new Widget();
        logo.id = 'theia:icon';
        logo.addClass('theia-icon');
        return logo;
    }
}

/**
 * Customized PhosphorJS command registry. Instead of registering the commands, we register
 * menu items. If you want to populate the commands for the menu items, call `use`,
 * and it will populate the command registry and freeze its state. So the backing command handlers
 * of the menu items won't change once the menu is visible.
 */
class MenuCommandRegistry extends PhosphorCommandRegistry {

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected actions = new Map<string, [ActionMenuNode, any[]]>();
    protected toDisposeOnReset = new DisposableCollection();

    constructor(protected services: MenuServices) {
        super();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerActionMenu(menu: ActionMenuNode, ...args: any[]): void {
        const { commandRegistry } = this.services;
        const command = commandRegistry.getCommand(menu.action.commandId);
        if (!command) {
            return;
        }
        const { id } = command;
        if (this.actions.has(id)) {
            return;
        }
        this.actions.set(id, [menu, args]);
    }

    use(): this {
        this.toDisposeOnReset.dispose();
        for (const [menu, args] of this.actions.values()) {
            this.toDisposeOnReset.push(this.registerCommand(menu, args));
        }
        return this;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected registerCommand(menu: ActionMenuNode, args: any[]): Disposable {
        const { commandRegistry, keybindingRegistry } = this.services;
        const command = commandRegistry.getCommand(menu.action.commandId);
        if (!command) {
            return Disposable.NULL;
        }
        const { id } = command;
        if (this.hasCommand(id)) {
            // several menu items can be registered for the same command in different contexts
            return Disposable.NULL;
        }

        // We freeze the `isEnabled`, `isVisible`, and `isToggled` states so they won't change.
        const enabled = commandRegistry.isEnabled(id, ...args);
        const visible = commandRegistry.isVisible(id, ...args);
        const toggled = commandRegistry.isToggled(id, ...args);
        const unregisterCommand = this.addCommand(id, {
            execute: () => commandRegistry.executeCommand(id, ...args),
            label: menu.label,
            icon: menu.icon,
            isEnabled: () => enabled,
            isVisible: () => visible,
            isToggled: () => toggled
        });

        const bindings = keybindingRegistry.getKeybindingsForCommand(id);

        // Only consider the first keybinding.
        if (bindings.length) {
            const binding = bindings[0];
            const keys = keybindingRegistry.acceleratorFor(binding);
            this.addKeyBinding({
                command: id,
                keys,
                selector: '.p-Widget' // We have the PhosphorJS dependency anyway.
            });
        }
        return Disposable.create(() => unregisterCommand.dispose());
    }

}
