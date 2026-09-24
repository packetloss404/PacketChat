"use client";

import { useSyncExternalStore } from "react";

export type ChatHeaderState = { title: string | null; modelLabel: string | null };

const SERVER_STATE: ChatHeaderState = { title: null, modelLabel: null };

let state: ChatHeaderState = SERVER_STATE;
const listeners = new Set<() => void>();

let pickerRequest = 0;
const pickerListeners = new Set<() => void>();

// setChatHeader merges a partial update and notifies subscribers.
export function setChatHeader(partial: Partial<ChatHeaderState>) {
  const next: ChatHeaderState = { ...state, ...partial };
  if (next.title === state.title && next.modelLabel === state.modelLabel) return;
  state = next;
  for (const listener of listeners) listener();
}

// getChatHeader returns the current state.
export function getChatHeader(): ChatHeaderState {
  return state;
}

// subscribeChatHeader registers a listener and returns an unsubscribe fn.
export function subscribeChatHeader(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// useChatHeader() returns the state via React.useSyncExternalStore.
export function useChatHeader(): ChatHeaderState {
  return useSyncExternalStore(subscribeChatHeader, getChatHeader, () => SERVER_STATE);
}

// requestModelPicker() increments a counter and notifies picker listeners.
export function requestModelPicker() {
  pickerRequest += 1;
  for (const listener of pickerListeners) listener();
}

function getModelPickerRequest(): number {
  return pickerRequest;
}

function subscribeModelPicker(listener: () => void): () => void {
  pickerListeners.add(listener);
  return () => {
    pickerListeners.delete(listener);
  };
}

// useModelPickerRequest() returns the counter via useSyncExternalStore.
export function useModelPickerRequest(): number {
  return useSyncExternalStore(subscribeModelPicker, getModelPickerRequest, () => 0);
}
