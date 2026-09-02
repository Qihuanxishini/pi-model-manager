// models.json 变更广播：保存成功后向 pi.events 发出不含 secret 的变更事件。
// manager 不知道也不关心消费者是谁；余额对账等由普通扩展自行订阅。

export const MODELS_CHANGED_EVENT = "pi-model-manager:models-changed";

export type ModelsChangeEvent =
	| { type: "provider-rename"; oldId: string; newId: string }
	| { type: "provider-delete"; providerId: string };

export interface ModelsChangedPayload {
	version: 1;
	at: string;
	events: ModelsChangeEvent[];
}

type ModelsChangeNotifier = (payload: ModelsChangedPayload) => void;

let notifier: ModelsChangeNotifier | undefined;

export function setModelsChangeNotifier(notify: ModelsChangeNotifier): void {
	notifier = notify;
}

export function notifyModelsChanged(events: readonly ModelsChangeEvent[]): void {
	if (events.length === 0 || !notifier) return;
	try {
		notifier({ version: 1, at: new Date().toISOString(), events: [...events] });
	} catch {
		// 广播失败不能影响已完成的配置保存。
	}
}
