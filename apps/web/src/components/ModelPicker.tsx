import { useCallback } from "react";
import { api, ApiError, type ModelConnection } from "../api/client";
import { useResource } from "../lib/useResource";

export interface ModelChoice {
  connectionId: string;
  model: string;
}
export function useModelConnections(projectId: string) {
  return useResource(
    useCallback(
      async (signal: AbortSignal) => {
        try {
          return {
            connections: (await api.listModelConnections(projectId, signal)).filter(
              (item) => !item.disabledAt,
            ),
            legacy: false,
          };
        } catch (error) {
          if (error instanceof ApiError && error.status === 404)
            return { connections: [], legacy: true };
          throw error;
        }
      },
      [projectId],
    ),
  );
}
export function ModelPicker({
  label,
  connections,
  legacy,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  connections: ModelConnection[];
  legacy: boolean;
  value: ModelChoice;
  onChange: (value: ModelChoice) => void;
  disabled?: boolean;
}) {
  const connection = connections.find((item) => item.id === value.connectionId);
  return (
    <fieldset disabled={disabled} className="flow-form">
      <legend>{label}</legend>
      {legacy ? (
        <p>使用服务器默认连接。请填写该服务提供的准确模型名称；不会在浏览器中读取服务器密钥。</p>
      ) : (
        <label>
          模型连接
          <select
            required
            value={value.connectionId}
            onChange={(e) => onChange({ connectionId: e.target.value, model: "" })}
          >
            <option value="">请选择连接</option>
            {connections.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {legacy ? (
        <label>
          模型名称
          <input
            required
            maxLength={240}
            value={value.model}
            onChange={(e) => onChange({ connectionId: "", model: e.target.value })}
          />
        </label>
      ) : (
        <label>
          模型
          <select
            required
            disabled={!connection}
            value={value.model}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
          >
            <option value="">请选择模型</option>
            {connection?.allowedModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
      )}
      {!legacy && connections.length === 0 && (
        <p role="status">暂无可用连接，请先在“模型连接”页面添加。</p>
      )}
    </fieldset>
  );
}
