/**
 * Message queue for WeChat → Claude injection.
 *
 * Thread-safe FIFO queue with deduplication by msgId.
 */

export interface QueueItem {
  msgId: string;
  from: string;
  text: string;
  timestamp: number;
}

export class MessageQueue {
  private items: QueueItem[] = [];
  private seen = new Set<string>();

  enqueue(item: QueueItem): boolean {
    if (this.seen.has(item.msgId)) return false;
    this.seen.add(item.msgId);
    this.items.push(item);
    return true;
  }

  dequeue(): QueueItem | undefined {
    return this.items.shift();
  }

  peek(): QueueItem | undefined {
    return this.items[0];
  }

  get length(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  clear(): void {
    this.items = [];
    this.seen.clear();
  }
}
