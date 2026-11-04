import Foundation

@main struct BrowserLoginTests {
    @MainActor static func waitForPending(_ login: BrowserLogin) async {
        for _ in 0..<1000 {
            if login.isPending { return }
            await Task.yield()
        }
        fatalError("Login did not become pending")
    }
    @MainActor static func expectFailure(_ task: Task<URL, Error>, _ description: String) async {
        do { _ = try await task.value; fatalError(description) } catch {}
    }
    @MainActor static func main() async throws {
        assert(RelayFailure("管理员尚未发布配置", status: 409).isPolicyUnavailable)
        assert(RelayFailure("没有获授权的已发布节点", status: 403).isPolicyUnavailable)
        for code in [401, 403, 500, 503] { assert(!RelayFailure("员工未授权", status: code).isPolicyUnavailable) }
        print("PASS missing policy remains distinct from revoked authentication")
        let url = URL(string: "https://example.com/auth/desktop/start?state=test-only-state")!
        let callback = URL(string: "relay-enterprise://auth/callback?transaction=expected&ticket=test-only-ticket-123456")!
        var opened: [URL] = []
        let login = BrowserLogin { opened.append($0); return true }
        assert(!login.accept(callback))
        assert(!login.reopen())

        let first = Task { @MainActor in try await login.begin(url: url, transactionId: "expected") }
        await waitForPending(login)
        assert(opened == [url])
        assert(login.reopen() && opened == [url, url])
        for invalid in [
            "relay-enterprise://auth/callback?transaction=other&ticket=test-only-ticket-123456",
            "https://auth/callback?transaction=expected&ticket=test-only-ticket-123456",
            "relay-enterprise://other/callback?transaction=expected&ticket=test-only-ticket-123456",
            "relay-enterprise://auth/callback?transaction=expected&transaction=expected&ticket=test-only-ticket-123456",
            "relay-enterprise://auth/callback?transaction=expected&ticket=short",
            "relay-enterprise://auth/callback?transaction=expected&ticket=test-only-ticket-123456#fragment"
        ] { assert(!login.accept(URL(string: invalid)!)) }
        assert(login.isPending && login.accept(callback))
        assert(!login.accept(callback) && !login.isPending)
        let result = try await first.value
        assert(result == callback)
        print("PASS browser opening, reopen, callback binding and duplicate rejection")

        let cancel = Task { @MainActor in try await login.begin(url: url, transactionId: "expected") }
        await waitForPending(login); login.cancel(); login.cancel()
        await expectFailure(cancel, "Cancellation did not release login")
        assert(!login.isPending)
        print("PASS cancellation clears pending login")

        let timeout = Task { @MainActor in try await login.begin(url: url, transactionId: "expected", timeoutNanoseconds: 1_000_000) }
        await expectFailure(timeout, "Timeout did not release login")
        assert(!login.isPending && !login.accept(callback))
        print("PASS timeout unlocks retry and rejects late callback")

        let noBrowser = BrowserLogin { _ in false }
        let failedOpen = Task { @MainActor in try await noBrowser.begin(url: url, transactionId: "expected") }
        await expectFailure(failedOpen, "Failed browser open was ignored")
        assert(!noBrowser.isPending)
        print("PASS browser launch failure is recoverable")

        let original = Task { @MainActor in try await login.begin(url: url, transactionId: "expected") }
        await waitForPending(login)
        let duplicate = Task { @MainActor in try await login.begin(url: url, transactionId: "other") }
        await expectFailure(duplicate, "Concurrent login replaced the original")
        assert(login.accept(callback)); _ = try await original.value
        print("PASS concurrent login cannot replace a pending transaction")

        let cancelledTask = Task { @MainActor in try await login.begin(url: url, transactionId: "expected") }
        await waitForPending(login); cancelledTask.cancel()
        await expectFailure(cancelledTask, "Task cancellation did not release login")
        let retry = Task { @MainActor in try await login.begin(url: url, transactionId: "expected") }
        await waitForPending(login); assert(login.accept(callback)); _ = try await retry.value
        print("PASS task cancellation permits an independent retry")
    }
}
