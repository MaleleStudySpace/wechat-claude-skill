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
  /** Whether this item has been shown in terminal as notification (while waiting for Claude to be idle) */
  notified?: boolean;
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

  /** Dequeue all items and clear the seen set. Returns items in FIFO order. */
  dequeueAll(): QueueItem[] {
    const items = this.items;
    this.items = [];
    this.seen.clear();
    return items;
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
