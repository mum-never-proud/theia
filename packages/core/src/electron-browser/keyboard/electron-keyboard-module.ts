/********************************************************************************
 * Copyright (C) 2019 TypeFox and others.
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

import { ContainerModule } from 'inversify';
import { KeyboardLayoutProvider, keyboardPath, KeyboardLayoutChangeNotifier } from '../../common/keyboard/keyboard-layout-provider';
import { WebSocketConnectionProvider } from '../../browser/messaging/ws-connection-provider';
import { ElectronKeyboardLayoutChangeNotifier } from './electron-keyboard-layout-change-notifier';
import { UndoHandler, RedoHandler, SelectAllHandler } from '../../browser/common-frontend-contribution';
import { ElectronUndoHandler, ElectronRedoHandler, ElectronSelectAllHandler } from './electron-common-commands';

export default new ContainerModule((bind, unbind, isBound, rebind) => {
    bind(KeyboardLayoutProvider).toDynamicValue(ctx =>
        WebSocketConnectionProvider.createProxy<KeyboardLayoutProvider>(ctx.container, keyboardPath)
    ).inSingletonScope();
    bind(ElectronKeyboardLayoutChangeNotifier).toSelf().inSingletonScope();
    bind(KeyboardLayoutChangeNotifier).toService(ElectronKeyboardLayoutChangeNotifier);
    rebind(UndoHandler).to(ElectronUndoHandler).inSingletonScope();
    rebind(RedoHandler).to(ElectronRedoHandler).inSingletonScope();
    rebind(SelectAllHandler).to(ElectronSelectAllHandler).inSingletonScope();
});
