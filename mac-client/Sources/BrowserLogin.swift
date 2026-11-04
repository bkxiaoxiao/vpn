import Foundation

// Opening the normal browser avoids macOS authentication sessions that can
// report a successful start without presenting any window. The server still
// binds the one-time ticket to this installation's PKCE verifier.
@MainActor final class BrowserLogin {
    private struct Pending {
        let id: UUID
        let url: URL
        let transactionId: String
        let continuation: CheckedContinuation<URL, Error>
    }
    private let opener: (URL) -> Bool
    private var pending: Pending?
    private var deadline: Task<Void, Never>?
    var isPending: Bool { pending != nil }

    init(opener: @escaping (URL) -> Bool) { self.opener = opener }

    func begin(url: URL, transactionId: String, timeoutNanoseconds: UInt64 = 300_000_000_000) async throws -> URL {
        try Task.checkCancellation()
        guard pending == nil else { throw RelayFailure("已有登录正在进行，请先取消") }
        let attempt = UUID()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                pending = Pending(id: attempt, url: url, transactionId: transactionId, continuation: continuation)
                deadline = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: timeoutNanoseconds) } catch { return }
                    self?.finish(.failure(RelayFailure("飞书登录已超时，请重新发起登录。")), attempt: attempt)
                }
                if !opener(url) {
                    finish(.failure(RelayFailure("无法打开默认浏览器，请检查系统默认浏览器设置后重试。")), attempt: attempt)
                }
            }
        }, onCancel: { [weak self] in
            Task { @MainActor in self?.cancel(attempt: attempt) }
        })
    }

    func reopen() -> Bool {
        guard let pending else { return false }
        if opener(pending.url) { return true }
        finish(.failure(RelayFailure("无法重新打开默认浏览器，请重试登录。")), attempt: pending.id)
        return false
    }

    @discardableResult func accept(_ url: URL) -> Bool {
        guard let pending,
              let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              c.scheme == "relay-enterprise", c.host == "auth", c.path == "/callback",
              c.user == nil, c.password == nil, c.port == nil, c.fragment == nil,
              let items = c.queryItems, items.count == 2,
              items.filter({ $0.name == "transaction" }).count == 1,
              items.filter({ $0.name == "ticket" }).count == 1,
              items.first(where: { $0.name == "transaction" })?.value == pending.transactionId,
              let ticket = items.first(where: { $0.name == "ticket" })?.value,
              (16...200).contains(ticket.count),
              ticket.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return false }
        finish(.success(url), attempt: pending.id)
        return true
    }

    func cancel() { if let pending { cancel(attempt: pending.id) } }
    private func cancel(attempt: UUID) {
        finish(.failure(RelayFailure("已取消飞书登录。")), attempt: attempt)
    }
    private func finish(_ result: Result<URL, Error>, attempt: UUID) {
        guard let current = pending, current.id == attempt else { return }
        pending = nil
        deadline?.cancel(); deadline = nil
        current.continuation.resume(with: result)
    }
}
