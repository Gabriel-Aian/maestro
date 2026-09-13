# Roteiro de testes manuais — casca Electron (GUI)

Checklist de casos de uso para testar a GUI do Maestro na prática, tela por tela. Feito para rodar no Windows real do usuário — é o único jeito de exercitar navegador de verdade e o Agendador de Tarefas (RNF a parte; este projeto foi desenvolvido num container Linux, sem os dois).

Cada caso marcado com **(já verificado)** foi confirmado ao vivo neste ambiente de desenvolvimento via Xvfb (`webContents.capturePage()` contra dados semeados) ou, no caso do instalador, rodando o build de verdade — ver CLAUDE.md, seção "Estado atual", para os detalhes de cada verificação. Os demais nunca rodaram contra navegador, Agendador de Tarefas ou instalação reais — são exatamente os casos que mais importam testar primeiro.

## Como usar

1. `npm install` e depois `npm run electron:dev` (janela + hot reload) — mais rápido para iterar — ou instale de verdade via `npm run package:win` e o instalador gerado.
2. Tenha à mão pelo menos: dois navegadores instalados (ex.: Chrome e Edge), um site de teste onde você possa logar sem risco (evite testar `record`/pesquisas em contas de produção — ver o aviso sobre ToS no fim do CLAUDE.md).
3. Alguns casos pedem dado semeado pela CLI antes de abrir a GUI (fluxo gravado, arquivo de pesquisas) — indicado em cada seção.
4. Marque `[x]` conforme for testando. Quando algo falhar, anote o comportamento real ao lado do item — é exatamente esse tipo de relato que fez esta sessão encontrar bugs reais em cada tela (ver "Regras que o código assume" no CLAUDE.md).

---

## 0. Preparação — dados de teste pela CLI

```bash
node dist/cli.js doctor                                   # confirma navegadores detectados
node dist/cli.js profile add conta-1 --browser chrome
node dist/cli.js profile add conta-2 --browser edge
node dist/cli.js record "Fluxo de teste" --url https://example.com --profile conta-1
```

Para Pesquisas, crie um `searches.json` (ver `examples/searches.example.json` como modelo) com pelo menos um tema habilitado apontando para `conta-1`.

---

## 1. Fila

- [ ] **1.1** Abrir a tela com a fila vazia mostra "Nenhum job pendente ou em execução." **(já verificado)**
- [ ] **1.2** Disparar um fluxo (seção 4) e voltar para Fila: o job aparece em "Fila" com status `pendente`/`em execução` **sem precisar clicar em Atualizar** — a tela reage sozinha aos eventos. **(já verificado, mecanismo)**
- [ ] **1.3** Job concluído (sucesso ou falha) desaparece da lista de ativos e aparece em "Concluídos recentemente" com o status certo.
- [ ] **1.4** Cancelar um job **pendente** (antes de começar a rodar) — para e não deixa rastro de execução.
- [ ] **1.5** Cancelar um job **em execução** (ex.: um fluxo lento) — a automação para de fato (navegador fecha, ou o passo atual é abortado).
- [ ] **1.6** "Parar tudo" com jobs ativos pede confirmação antes de agir; confirmando, cancela todos os pendentes e mata os em execução.
- [ ] **1.7** "Parar tudo" fica desabilitado quando não há job ativo algum.
- [ ] **1.8** Dois jobs do **mesmo perfil** enfileirados juntos: o segundo só começa depois que o primeiro termina (mutex por perfil, RN-001) — nunca em paralelo.
- [ ] **1.9** Dois jobs de **perfis diferentes** enfileirados juntos: rodam em paralelo (até o teto de "Navegadores simultâneos" de Configurações).

## 2. Histórico

- [ ] **2.1** Lista mostra execuções passadas (fluxos e pesquisas) com status, tipo, alvo, perfil, início, duração.
- [ ] **2.2** Filtro por status (ex.: só "failed") reduz a lista corretamente.
- [ ] **2.3** Filtro por tipo ("Só fluxos" / "Só pesquisas") funciona.
- [ ] **2.4** Combinar os dois filtros ao mesmo tempo funciona (ex.: pesquisas + bloqueadas).
- [ ] **2.5** "Carregar mais" pagina sem duplicar nem pular linhas.
- [ ] **2.6** Terminar um job em qualquer outra tela atualiza o Histórico sozinho (sem precisar trocar de tela e voltar).
- [ ] **2.7** Execução com passo degradado (fallback de seletor) mostra o aviso "⚠ degradado".
- [ ] **2.8** Execução bloqueada (CAPTCHA/parede de login) mostra "bloqueado: `<motivo>`" na coluna Observação.

## 3. Perfis e Navegadores

- [ ] **3.1** Navegadores instalados de verdade (Chrome/Edge/Brave) aparecem como detectados, com o caminho do executável preenchido. **Este é o primeiro caso real de detecção via Registro do Windows neste projeto — nunca confirmado fora da máquina do usuário.**
- [ ] **3.2** Um navegador **não instalado** aparece como "não encontrado", com a opção "Registrar caminho".
- [ ] **3.3** Registrar um caminho manual válido: some o botão de "Registrar", aparece "Trocar caminho"; tentar rodar um fluxo/pesquisa nesse navegador **imediatamente depois, sem reiniciar o app**, funciona (valida a correção desta sessão para `Maestro.updateConfig()` — antes só valia após reiniciar).
- [ ] **3.4** Registrar um caminho que não é um executável válido mostra mensagem de erro clara, não trava a tela.
- [ ] **3.5** Criar um perfil novo aparece na lista com status "nunca autenticado".
- [ ] **3.6** "Fazer login": abre o navegador de verdade (sem nenhuma automação visível/CDP) e o widget flutuante aparece por cima.
- [ ] **3.7** Fazer login de verdade no site e clicar "Concluí o login" **com o navegador ainda aberto**: o widget deve recusar (botão fica desabilitado enquanto o navegador não fecha) — nunca deixa marcar "autenticado" com o processo ainda vivo.
- [ ] **3.8** Fechar o navegador por completo e clicar "Concluí o login": perfil passa para "autenticado" e o widget fecha sozinho.
- [ ] **3.9** "Cancelar" no widget fecha a janela sem marcar o perfil como autenticado.
- [ ] **3.10** Provedor de identidade (Google/Microsoft) tentado num contexto automatizado deve recusar login — mas aqui o login é `openProfilePlain` sem CDP, então isso não deveria acontecer; confirmar que o login funciona normalmente nesses provedores.
- [ ] **3.11** Remover um perfil tira ele da lista; os arquivos de sessão continuam no disco (não é apagado, só desvinculado).
- [ ] **3.12** Um perfil com "navegador aberto agora" (badge) não permite novo login nem fica disponível para rodar jobs até fechar.

## 4. Fluxos

- [ ] **4.1** Lista mostra os fluxos gravados via `maestro record`, com nome, quantidade de passos e última execução.
- [ ] **4.2** Fluxo nunca rodado mostra "nunca rodou" em vez de um badge de status.
- [ ] **4.3** "Ver e rodar" expande o fluxo mostrando URL inicial e a lista de passos.
- [ ] **4.4** Fluxo com variáveis mostra um campo por variável, pré-preenchido com o valor padrão gravado; variável marcada como sensível aparece como campo de senha (mascarado).
- [ ] **4.5** Rodar um fluxo válido (perfil autenticado, navegador detectado): mostra "Executando…", depois o resultado completo (status, duração, passo a passo) **sem nenhuma confirmação intermediária** — é o comportamento pedido explicitamente para esta tela.
- [ ] **4.6** Rodar num perfil com sessão expirada: erro claro antes de tentar abrir navegador algum (RN-004/RN-015) — não sobe nenhum processo de navegador.
- [ ] **4.7** Rodar sem preencher uma variável obrigatória: erro antes de abrir navegador (RN-015). **(já verificado)**
- [ ] **4.8** Rodar apontando para um navegador não detectado: erro claro ("Navegador ... não foi detectado"), sem travar a tela. **(já verificado, com navegador ausente neste ambiente)**
- [ ] **4.9** Marcar "executar visível" e rodar: o navegador abre uma janela visível de verdade (headed), não headless.
- [ ] **4.10** Fluxo cujo site mudou o suficiente para um seletor cair no fallback: resultado mostra "⚠ degradado" no passo certo e o badge "revisar" aparece na lista de fluxos depois.
- [ ] **4.11** Fluxo que bate numa parede de login/CAPTCHA durante a execução: status final "bloqueado" com o motivo, e o perfil usado fica com sessão marcada como expirada (RN-004) — confirmar que uma tentativa seguinte no mesmo perfil já barra antes de abrir navegador (ver 4.6).

## 5. Pesquisas

- [ ] **5.1** "Selecionar arquivo…" abre o diálogo nativo do SO; escolher um `searches.json` válido carrega a lista de temas.
- [ ] **5.2** Arquivo com JSON malformado mostra o erro de sintaxe de forma legível (não trava, oferece "Recarregar"/"Abrir pasta" mesmo assim). **(já verificado)**
- [ ] **5.3** Arquivo com erro de schema (ex.: campo obrigatório faltando) mostra os problemas campo a campo, sem duplicar a mensagem.
- [ ] **5.4** "Abrir pasta" abre o explorador de arquivos do Windows na pasta do arquivo selecionado.
- [ ] **5.5** Editar o arquivo por fora (outro editor) e **voltar o foco para a janela do Maestro**: a tela recarrega sozinha, sem precisar clicar em "Recarregar".
- [ ] **5.6** Tema desabilitado no arquivo (`enabled: false`) aparece com o checkbox travado e a etiqueta "(desativado no arquivo)".
- [ ] **5.7** Selecionar um subconjunto de temas e rodar: só os temas marcados entram no lote.
- [ ] **5.8** Rodar pesquisas com dois perfis diferentes no mesmo arquivo: um job por perfil, rodando em paralelo (RF-050).
- [ ] **5.9** Um dos perfis do lote tem sessão expirada: **nenhum** job é enfileirado, nem dos perfis válidos (tudo ou nada — RN-004/RN-015). **(já verificado)**
- [ ] **5.10** Pesquisa cujo navegador não é detectado: falha aparece na tabela de resultado com a mensagem real do erro (não em branco). **(já verificado)**
- [ ] **5.11** Delay aleatório entre pesquisas (RN-008) é perceptível — pesquisas do mesmo perfil não disparam de forma instantânea uma após a outra.

## 6. Agendamentos

- [ ] **6.1** Criar um agendamento de **fluxo**: escolher fluxo + perfil, preencher variáveis, cron válido — aparece na lista com "próxima execução" calculada corretamente.
- [ ] **6.2** Criar um agendamento de **pesquisas**: escolher arquivo (diálogo nativo) e, opcionalmente, um subconjunto de temas.
- [ ] **6.3** Cron inválido (ex.: `"não é cron"`) mostra mensagem de erro legível ao salvar, não um JSON cru. **(já verificado)**
- [ ] **6.4** "Rodar agora" dispara pela fila de verdade; "última execução" da linha atualiza sozinha (sem apertar nada) assim que o job termina — mesmo em caso de falha. **(já verificado, incluindo o caso de falha)**
- [ ] **6.5** Desativar um agendamento muda o status para "desativado"; reativar volta para "ativo". Um agendamento desativado não deve disparar sozinho pelo Agendador de Tarefas (ver 6.8).
- [ ] **6.6** Remover um agendamento tira ele da lista (com confirmação).
- [ ] **6.7** "Verificar status" da tarefa do Windows mostra corretamente se `MaestroScheduleTick` está registrada ou não.
- [ ] **6.8** "Ver comando" mostra o `schtasks` exato que seria executado, citando o próprio executável do Maestro (não um "node" externo) quando rodando a partir do app instalado. **(já verificado o mecanismo — falta confirmar o texto exato mostrado pela build empacotada instalada de verdade)**
- [ ] **6.9** "Instalar tarefa" registra de verdade no Agendador de Tarefas do Windows (confirmar com `schtasks /query /tn MaestroScheduleTick` fora do app) — **primeira vez que isso roda contra um Agendador de Tarefas real**.
- [ ] **6.10** Esperar o intervalo configurado passar com um agendamento ativo e válido: o job dispara sozinho, mesmo com a janela do Maestro fechada (a tarefa chama o app empacotado, não depende da GUI estar aberta).
- [ ] **6.11** "Remover tarefa" desregistra a tarefa; confirmar que agendamentos não disparam mais sozinhos depois disso.
- [ ] **6.12** Um agendamento cujo alvo falha sempre (ex.: perfil com sessão expirada) tem "última execução" atualizada para "falhou" a cada tick — nunca fica preso em "nunca rodou" enquanto dispara de verdade em segundo plano.

## 7. Configurações

- [ ] **7.1** Tela abre com os valores reais do `config.json` atual (não os defaults, a menos que o arquivo não exista ainda).
- [ ] **7.2** Mudar "Rodar sem interface por padrão" e salvar: o próximo fluxo/pesquisa rodado **sem marcar explicitamente "executar visível"** respeita o novo padrão.
- [ ] **7.3** Mudar viewport padrão e salvar: próxima execução usa a nova resolução (percebível em screenshots/artefatos, se capturados).
- [ ] **7.4** Digitar um valor não numérico num campo numérico e salvar: erro claro, nada é persistido. **(já verificado)**
- [ ] **7.5** Digitar um valor numérico fora do limite (ex.: tentativas por passo muito alto) e salvar: mensagem legível citando o campo e o limite, não JSON cru. **(já verificado)**
- [ ] **7.6** "Restaurar padrões" volta o formulário aos valores originais do schema — mas só persiste depois de clicar "Salvar" (fechar sem salvar não deve mudar nada).
- [ ] **7.7** Mudar "Navegadores simultâneos"/"Timeout máximo por job"/"Atraso entre jobs"/"Ociosidade do navegador" e salvar: valor grava no arquivo, mas o comportamento da fila **só muda depois de reiniciar o app** — confirmar que a tela avisa isso e que o comportamento antigo continua valendo até reiniciar.
- [ ] **7.8** Fechar e reabrir o app depois de salvar: todos os valores persistidos continuam lá (não voltam ao default).
- [ ] **7.9** Mudar "Idade máxima"/"Máximo de execuções retidas" de retenção e confirmar (via CLI ou observando `runs`) que a limpeza de artefatos passa a respeitar o novo valor.

## 8. Instalador Windows (empacotamento)

**Nenhum destes rodou contra um Windows real ainda — só a build (`npm run package:win`) foi confirmada de ponta a ponta num ambiente Linux com wine (ver CLAUDE.md).**

- [ ] **8.1** Rodar `Maestro-Setup-<versão>.exe` num Windows limpo: instala sem erros, sem exigir nada além de aceitar o aviso do SmartScreen (esperado — não há certificado de assinatura ainda).
- [ ] **8.2** Instalador permite escolher a pasta de instalação (não é "one-click").
- [ ] **8.3** Atalho é criado na área de trabalho e no menu iniciar.
- [ ] **8.4** App abre normalmente após instalado, chegando até a tela de Fila (ou a última tela usada).
- [ ] **8.5** Detecção de navegadores funciona igual à versão rodada via `electron:dev` (mesmo Registro do Windows, mesmo código).
- [ ] **8.6** "Instalar tarefa" pela GUI empacotada realmente registra a tarefa (ver 6.9) — este é o caso que valida a decisão de usar `ELECTRON_RUN_AS_NODE=1` com o próprio executável em vez de exigir Node.js instalado à parte.
- [ ] **8.7** Desinstalar pelo painel de controle do Windows remove o app e os atalhos; os dados em `%APPDATA%\Maestro` **não** devem ser apagados automaticamente (perfis/histórico são dados do usuário, não do programa).

## 9. Casos cross-cutting

- [ ] **9.1** Fechar a janela com jobs em execução: o app espera a fila terminar antes de sair de vez (não mata o processo do navegador abruptamente).
- [ ] **9.2** Trocar de tela enquanto um job roda em segundo plano e voltar: o estado da fila/histórico continua correto (nada se perde por não estar "olhando").
- [ ] **9.3** Vários jobs disparados quase ao mesmo tempo em telas diferentes (ex.: um fluxo e uma pesquisa) não se atrapalham — cada um aparece corretamente na Fila e no Histórico.
- [ ] **9.4** Navegar entre as sete telas repetidamente não deixa a UI mais lenta nem gera erros no console (`console-message` do processo principal, visível no log se rodando via terminal).
