import ARKit
import AVFoundation

struct ScanViewStep {
    let angle: ScanViewAngle
    let instruction: String
}

@MainActor
final class ScanCoach: NSObject, ObservableObject {
    @Published var currentInstruction: String = "请等待 AR 初始化…"
    @Published var stepIndex: Int = 0

    private let synthesizer = AVSpeechSynthesizer()

    static let viewSequence: [ScanViewStep] = [
        ScanViewStep(angle: .front, instruction: "正面：请面对镜头站立，后退一步让头到脚都在画面中。"),
        ScanViewStep(angle: .left, instruction: "左侧：向左转约 90 度侧身，保持全身轮廓可见。"),
        ScanViewStep(angle: .right, instruction: "右侧：向右转约 90 度侧身，保持全身轮廓可见。"),
        ScanViewStep(angle: .back, instruction: "背面：背对镜头，尽量让肩、背、腿部入镜。"),
        ScanViewStep(angle: .gesture, instruction: "建言姿势：转回正面，抬起右手致意——这是你的虚像姿态。")
    ]

    static let completeMessage = "各方位已记录。点击「保存虚像」完成扫描。"

    func reset(mode: ScanMode) {
        stepIndex = 0
        switch mode {
        case .guided:
            speak(Self.viewSequence[0].instruction)
        case .assisted:
            currentInstruction = "请朋友持机拍摄。每个方位站稳后点击「记录此方位」，完成后保存。"
            speak(currentInstruction)
        }
    }

    func advance(mode: ScanMode) {
        guard mode == .guided else { return }
        if stepIndex < Self.viewSequence.count {
            stepIndex += 1
        }
        if stepIndex < Self.viewSequence.count {
            speak(Self.viewSequence[stepIndex].instruction)
        } else {
            speak(Self.completeMessage)
        }
    }

    var currentAngle: ScanViewAngle? {
        guard stepIndex < Self.viewSequence.count else { return nil }
        return Self.viewSequence[stepIndex].angle
    }

    func suggestNextAngle(existing: [PoseView]) -> ScanViewAngle {
        for step in Self.viewSequence where !existing.contains(where: { $0.angle == step.angle }) {
            return step.angle
        }
        return .front
    }

    private func speak(_ text: String) {
        currentInstruction = text
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN")
        utterance.rate = 0.48
        synthesizer.stopSpeaking(at: .immediate)
        synthesizer.speak(utterance)
    }
}

struct PoseCaptureManager {
    static func snapshot(from bodyAnchor: ARBodyAnchor) -> [JointSnapshot] {
        let jointNames = bodyAnchor.skeleton.definition.jointNames
        return jointNames.compactMap { name in
            guard let transform = bodyAnchor.skeleton.modelTransform(for: ARSkeleton.JointName(rawValue: name)) else {
                return nil
            }
            return JointSnapshot(name: name, matrix: transform)
        }
    }

    static func validateFullBody(joints: [JointSnapshot]) -> (ok: Bool, message: String) {
        let required = ["head_joint", "left_foot_joint", "right_foot_joint", "left_shoulder_1_joint", "right_shoulder_1_joint"]
        let names = Set(joints.map(\.name))
        let missing = required.filter { !names.contains($0) }
        if !missing.isEmpty {
            return (false, "未检测到完整全身，请后退并保证头脚都在画面中。")
        }
        if joints.count < 20 {
            return (false, "关节数据不足，请调整距离与光线。")
        }
        return (true, "全身轮廓检测良好。")
    }
}
