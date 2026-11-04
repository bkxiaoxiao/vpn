import Foundation

enum RouteLatency: Equatable, Sendable {
    case measured(Int)
    case unreachable
    var label: String {
        switch self {
        case .measured(let milliseconds): return "\(milliseconds) ms"
        case .unreachable: return "超时/不可达"
        }
    }
}

struct RouteLatencySnapshot {
    static let refreshInterval: TimeInterval = 3600
    var values: [String: RouteLatency] = [:]
    var updatedAt: Date?
    func needsRefresh(at date: Date = Date()) -> Bool {
        guard let updatedAt else { return true }
        return date < updatedAt || date.timeIntervalSince(updatedAt) >= Self.refreshInterval
    }
    func label(for route: String, measuring: Bool) -> String {
        values[route]?.label ?? (measuring ? "检测中…" : "未检测")
    }
}
