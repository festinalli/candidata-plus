import type { BgResponse, ContentToBgMessage, PanelToBgMessage } from '../shared/messages.ts';
import { makeQuestionKey } from '../shared/normalize.ts';
import { loadResumePdf, loadState, saveResumePdf, updateState } from '../shared/storage.ts';
import { buildLinkedInSearchUrl } from '../shared/search-url.ts';
import { salaryQuestionKind } from '../shared/normalize.ts';
import { discoverGeminiModels } from '../core/gemini.ts';
import { extractLocalResumeFacts, generateKnowledgeBaseFromResume } from '../core/knowledge.ts';
import { runLiveAiSelfTest } from '../core/ai-test.ts';
import { pauseBatchRunner, recoverInterruptedRun, resumeBatchRunner, startBatchRunner, stopBatchRunner } from './runner.ts';

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

// O serviço acabou de acordar: se um envio ficou marcado como "rodando", ele foi interrompido. Fecha com o motivo.
void recoverInterruptedRun().catch(() => undefined);

/** O PDF só é necessário quando a leitura local não achou texto (PDF escaneado). */
async function pdfForKnowledge(resumeText: string): Promise<string | undefined> {
  return resumeText.trim().length >= 40 ? undefined : loadResumePdf();
}

let kbBuildInFlight = false;

/**
 * Monta a Ficha de Conhecimento em segundo plano sem travar nenhum botão da tela!
 */
function triggerBackgroundKbBuild(): void {
  if (kbBuildInFlight) return;
  kbBuildInFlight = true;
  void (async () => {
    try {
      const st = await loadState();
      if (!st.resume || !st.ai.apiKey.trim()) return;
      const kbRes = await generateKnowledgeBaseFromResume({
        apiKey: st.ai.apiKey,
        preferredModel: st.ai.preferredModel,
        userPickedModel: st.ai.userPickedModel,
        discoveredModels: st.ai.discoveredModels,
        resumeText: st.resume.text,
        pdfBase64: await pdfForKnowledge(st.resume.text),
        existing: st.knowledge,
        todayIso: new Date().toISOString().slice(0, 10),
      });
      if (kbRes.ok) {
        await updateState((cur) => ({
          ...cur,
          resume: cur.resume && kbRes.extractedText ? { ...cur.resume, text: kbRes.extractedText } : cur.resume,
          knowledge: kbRes.knowledge,
        }));
      }
    } finally {
      kbBuildInFlight = false;
    }
  })();
}

chrome.runtime.onMessage.addListener((rawMsg: unknown, sender, sendResponse) => {
  const msg = rawMsg as (PanelToBgMessage | ContentToBgMessage) | undefined;
  if (!msg || typeof msg.type !== 'string') return false;

  void (async (): Promise<BgResponse> => {
    try {
      switch (msg.type) {
        case 'OPEN_SIDE_PANEL': {
          if (sender.tab?.id) {
            await chrome.sidePanel.open({ tabId: sender.tab.id });
          }
          return { ok: true };
        }

        case 'MANUAL_FIELD_LEARNED': {
          const qKey = makeQuestionKey(msg.question, msg.fieldType);
          const now = new Date().toISOString();
          await updateState((st) => {
            const nextAnswers = [...st.answers];
            const idx = nextAnswers.findIndex((a) => a.questionKey === qKey);
            if (idx >= 0) {
              nextAnswers[idx] = {
                ...nextAnswers[idx]!,
                answer: msg.answer,
                source: 'manual_linkedin',
                updatedAt: now,
              };
            } else {
              nextAnswers.unshift({
                id: `ans_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                questionKey: qKey,
                question: msg.question,
                answer: msg.answer,
                fieldType: msg.fieldType,
                source: 'manual_linkedin',
                updatedAt: now,
              });
            }
            return {
              ...st,
              answers: nextAnswers.slice(0, 500),
              pending: st.pending.filter((p) => p.questionKey !== qKey),
            };
          });
          return { ok: true };
        }

        case 'SAVE_RESUME': {
          const now = new Date().toISOString();
          await saveResumePdf(msg.pdfBase64 && msg.pdfBase64.length <= 2_600_000 ? msg.pdfBase64 : undefined);
          const stAfterSave = await updateState((st) => ({
            ...st,
            resume: {
              fileName: msg.fileName,
              text: msg.text,
              updatedAt: now,
            },
            knowledge: extractLocalResumeFacts(msg.text, st.knowledge),
          }));

          // Dispara a montagem da ficha pela IA em segundo plano (resposta na tela é instantânea < 0.1s!)
          const willGenerateInBg = Boolean(stAfterSave.ai.apiKey.trim());
          if (willGenerateInBg) {
            triggerBackgroundKbBuild();
          }
          return { ok: true, data: { aiQueued: willGenerateInBg } };
        }

        case 'BUILD_KNOWLEDGE_FROM_AI': {
          const current = await loadState();
          if (!current.resume) {
            return { ok: false, error: 'Envie o PDF do currículo ou cole o texto dele no Passo 1 primeiro.' };
          }
          if (!current.ai.apiKey.trim()) {
            return { ok: false, error: 'Cole e salve a chave do Google AI Studio no Passo 2 primeiro.' };
          }

          const kbRes = await generateKnowledgeBaseFromResume({
            apiKey: current.ai.apiKey,
            preferredModel: current.ai.preferredModel,
            userPickedModel: current.ai.userPickedModel,
            discoveredModels: current.ai.discoveredModels,
            resumeText: current.resume.text,
            pdfBase64: await pdfForKnowledge(current.resume.text),
            existing: current.knowledge,
            todayIso: new Date().toISOString().slice(0, 10),
          });

          if (!kbRes.ok) {
            return { ok: false, error: kbRes.errorPtBr };
          }

          await updateState((st) => ({
            ...st,
            resume: st.resume && kbRes.extractedText ? { ...st.resume, text: kbRes.extractedText } : st.resume,
            knowledge: kbRes.knowledge,
          }));
          return { ok: true, data: { modelUsed: kbRes.modelUsed } };
        }

        case 'SAVE_KNOWLEDGE': {
          await updateState((st) => ({
            ...st,
            knowledge: msg.knowledge,
          }));
          return { ok: true };
        }

        case 'SAVE_AND_TEST_AI': {
          const apiKey = msg.apiKey.trim();
          if (!apiKey) {
            return { ok: false, error: 'Cole a chave do Google AI Studio antes de testar.' };
          }

          const disc = await discoverGeminiModels(apiKey);
          if (!disc.ok) {
            await updateState((st) => ({
              ...st,
              ai: {
                ...st.ai,
                apiKey,
                lastTestedAt: new Date().toISOString(),
                lastTestOk: false,
                lastTestSummary: disc.errorPtBr,
              },
            }));
            return { ok: false, error: disc.errorPtBr };
          }

          const userPickedModel = Boolean(msg.preferredModel) && disc.models.includes(msg.preferredModel);
          const chosenModel = userPickedModel ? msg.preferredModel : disc.bestModel;
          const stNow = await updateState((st) => ({
            ...st,
            ai: {
              apiKey,
              preferredModel: chosenModel,
              userPickedModel,
              discoveredModels: disc.models,
            },
          }));

          const testRes = await runLiveAiSelfTest({
            knowledge: {
              ...stNow.knowledge,
              acceptedWorkModes: stNow.settings.acceptedWorkModes,
            },
            resumeText: stNow.resume?.text ?? '',
            answers: stNow.answers,
            apiKey,
            preferredModel: chosenModel,
            userPickedModel,
            discoveredModels: disc.models,
            todayIso: new Date().toISOString().slice(0, 10),
          });

          const took = testRes.elapsedMs !== undefined ? ` em ${(testRes.elapsedMs / 1000).toFixed(1)} s` : '';
          const summary = testRes.ok
            ? `Funcionando com o modelo ${testRes.modelUsed ?? chosenModel}: respondeu${took}.`
            : (testRes.errorPtBr ?? 'Falha ao testar perguntas.');

          await updateState((st) => ({
            ...st,
            ai: {
              ...st.ai,
              preferredModel: userPickedModel ? chosenModel : (testRes.modelUsed ?? chosenModel),
              lastTestedAt: new Date().toISOString(),
              lastTestOk: testRes.ok,
              lastTestSummary: summary,
            },
          }));

          // Se já tem currículo e a ficha ainda não foi gerada, monta em segundo plano sem segurar a tela!
          if (stNow.resume && !stNow.knowledge.generatedByAiAt) {
            triggerBackgroundKbBuild();
          }

          if (!testRes.ok) {
            return { ok: false, error: summary };
          }
          return { ok: true, data: testRes };
        }

        case 'TEST_AI_WITH_RESUME': {
          const st = await loadState();
          if (!st.ai.apiKey.trim()) {
            return { ok: false, error: 'Cole e salve a chave do Google AI Studio primeiro.' };
          }
          const testRes = await runLiveAiSelfTest({
            knowledge: {
              ...st.knowledge,
              acceptedWorkModes: st.settings.acceptedWorkModes,
            },
            resumeText: st.resume?.text ?? '',
            answers: st.answers,
            apiKey: st.ai.apiKey,
            preferredModel: st.ai.preferredModel,
            userPickedModel: st.ai.userPickedModel,
            discoveredModels: st.ai.discoveredModels,
            todayIso: new Date().toISOString().slice(0, 10),
          });
          if (!testRes.ok) {
            return { ok: false, error: testRes.errorPtBr };
          }
          return { ok: true, data: testRes };
        }

        case 'SAVE_SETTINGS': {
          await updateState((st) => ({
            ...st,
            settings: msg.settings,
            knowledge: {
              ...st.knowledge,
              acceptedWorkModes: [...msg.settings.acceptedWorkModes],
            },
          }));
          return { ok: true };
        }

        case 'OPEN_LINKEDIN_SEARCH': {
          const st = await loadState();
          const targetUrl = buildLinkedInSearchUrl(st.knowledge.targetRole, st.settings.acceptedWorkModes);
          const liTabs = await chrome.tabs.query({ url: ['https://www.linkedin.com/*', 'https://*.linkedin.com/*'] });
          const activeLi = liTabs.find((t) => t.active) ?? liTabs[0];
          if (activeLi?.id) {
            await chrome.tabs.update(activeLi.id, { url: targetUrl, active: true });
          } else {
            await chrome.tabs.create({ url: targetUrl, active: true });
          }
          return { ok: true, data: { url: targetUrl } };
        }

        case 'ANSWER_PENDING': {
          const ans = msg.answer.trim();
          if (!ans) return { ok: false, error: 'Digite ou escolha uma resposta antes de salvar.' };
          const now = new Date().toISOString();
          await updateState((st) => {
            const pend = st.pending.find((p) => p.id === msg.pendingId);
            if (!pend) return st;

            const nextAnswers = [...st.answers];
            const idx = nextAnswers.findIndex((a) => a.questionKey === pend.questionKey);
            if (idx >= 0) {
              nextAnswers[idx] = {
                ...nextAnswers[idx]!,
                answer: ans,
                source: 'user',
                updatedAt: now,
              };
            } else {
              nextAnswers.unshift({
                id: `ans_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                questionKey: pend.questionKey,
                question: pend.question,
                answer: ans,
                fieldType: pend.fieldType,
                source: 'user',
                updatedAt: now,
              });
            }

            // Resposta de salário também vai para a Ficha: aí ela vale para qualquer jeito de perguntar o salário.
            const nextKb = { ...st.knowledge };
            const salaryKind = pend.options.length === 0 ? salaryQuestionKind(pend.question) : null;
            if (salaryKind === 'expectation' && !nextKb.salaryExpectation) {
              nextKb.salaryExpectation = ans.replace(/[^\d]/g, '') || ans;
            } else if (salaryKind === 'current' && !nextKb.currentSalary) {
              nextKb.currentSalary = ans.replace(/[^\d]/g, '') || ans;
            }

            return {
              ...st,
              knowledge: nextKb,
              answers: nextAnswers,
              pending: st.pending.filter((p) => p.questionKey !== pend.questionKey),
            };
          });
          return { ok: true };
        }

        case 'DELETE_PENDING': {
          await updateState((st) => ({
            ...st,
            pending: st.pending.filter((p) => p.id !== msg.pendingId),
          }));
          return { ok: true };
        }

        case 'SAVE_BANK_ANSWER': {
          const q = msg.question.trim();
          const a = msg.answer.trim();
          if (!q || !a) return { ok: false, error: 'Preencha a pergunta e a resposta.' };
          const fType = msg.fieldType ?? 'text';
          const qKey = makeQuestionKey(q, fType);
          const now = new Date().toISOString();
          await updateState((st) => {
            const nextAnswers = [...st.answers];
            const idx = nextAnswers.findIndex((x) => x.questionKey === qKey);
            if (idx >= 0) {
              nextAnswers[idx] = { ...nextAnswers[idx]!, question: q, answer: a, source: 'user', updatedAt: now };
            } else {
              nextAnswers.unshift({
                id: `ans_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                questionKey: qKey,
                question: q,
                answer: a,
                fieldType: fType,
                source: 'user',
                updatedAt: now,
              });
            }
            return { ...st, answers: nextAnswers };
          });
          return { ok: true };
        }

        case 'DELETE_BANK_ANSWER': {
          await updateState((st) => ({
            ...st,
            answers: st.answers.filter((a) => a.id !== msg.answerId),
          }));
          return { ok: true };
        }

        case 'START_BATCH': {
          const res = startBatchRunner(msg.preferredTabId);
          return res.started ? { ok: true } : { ok: false, error: res.error };
        }

        case 'PAUSE_BATCH': {
          await pauseBatchRunner();
          return { ok: true };
        }

        case 'RESUME_BATCH': {
          await resumeBatchRunner();
          return { ok: true };
        }

        case 'STOP_BATCH': {
          await stopBatchRunner();
          return { ok: true };
        }

        case 'CLEAR_DIARY': {
          await updateState((st) => ({
            ...st,
            run: { ...st.run, diary: [], jobs: [] },
          }));
          return { ok: true };
        }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Erro interno na extensão.' };
    }
  })().then(sendResponse);

  return true;
});
