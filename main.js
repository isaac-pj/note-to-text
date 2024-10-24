const {
  getResume,
  listarEntradas,
  listarTudo,
  listarSaidas,
  listarJuros,
  calcularSaidas,
  calcularJuros,
  calcularEntradas,
  listarDepositos,
  calcularValor,
  listarCredPix,
  listarEnvioPix,
} = require("./services/postProcessService");
const {
  recognizeDocuments,
  recognizeDocumentsBatch,
} = require("./services/tesseractService");
const { parseMonth } = require("./utils/dateUtils");
const prompt = require("prompt");
const {
  readFile,
  writeFile,
  exists,
  readFolder,
  extractZip,
  copyText,
  createFolder,
} = require("./services/fileSystemService");
const {
  getImagesFromPDF,
  getTextFromPDF,
} = require("./services/pdfParseService");
const {
  format,
  subMonths,
  addDays,
  subDays,
  isWithinInterval,
  parse,
  isThisMonth,
  subYears,
} = require("date-fns");
const { OEM } = require("tesseract.js");

const {
  csvToJsonMerge,
  formatCoraCSV,
  formatCaixaCSV,
} = require("./services/csvService");
const { ansiToUtf8All } = require("./utils/textUtils");
const { CSV_HEADER_TEMPLATE } = require("./constants/general");
const { folderBack } = require("./utils/generalUtils");

const lang = "por";
const base = "./notas";
let ano = null;
let mes = null;
let folderPath = null;
let filePath = null;
let importsFolderPath = null;
let importsRecePath = null;
let importsDespPath = null;
let coraFolderPath = null;
let shortMonth = null;
let resultPath = null;
let activeDate = null;
const today = new Date();

const getParams = async () => {
  prompt.start();
  console.clear();

  try {
    console.log("\n\nINFORME A DATA PARA CONSULTA: \n");
    const result = await prompt.get(["ano", "mes"]);
    const isFirstMonthOfYear = isThisMonth(new Date(2024, 0, 15));

    const defaultYear = isFirstMonthOfYear
      ? format(subYears(today, 1), "yyyy")
      : format(today, "yyyy");

    const defaultMonth = format(subMonths(today, 1), "MM");

    ano = result.ano || defaultYear;
    mes = result.mes || defaultMonth;

    if (!parseMonth(mes)) return getParams();

    const { confirm } = await prompt.get({
      properties: {
        confirm: {
          message: `Consultando dados de ${
            parseMonth(mes).name
          }. de ${ano}. Deseja continuar? (Enter) Sim / (N) Não`,
        },
      },
    });

    folderPath = `${base}/${ano}/${parseMonth(mes).name}`;
    filePath = `${folderPath}/nota.txt`;
    resultPath = `${folderPath}/result.txt`;
    importsFolderPath = `${folderPath}/imports`;
    coraFolderPath = `${folderPath}/cora`;
    activeDate = new Date(`${parseMonth(mes).number}/01/${ano}`);
    shortMonth = parseMonth(mes).name;
    importsRecePath = `${importsFolderPath}/${shortMonth}_RECE_IMPORT.csv`;
    importsDespPath = `${importsFolderPath}/${shortMonth}_DESP_IMPORT.csv`;

    return confirm?.toUpperCase() === "N"
      ? getParams()
      : { ano, mes: parseMonth(mes).name };
  } catch (error) {
    console.log(error);
  }
};

const getNota = async (folderPath) => {
  const [fileName] = readFolder(folderPath).filter((names) =>
    names.includes(`${parseMonth(mes).number} CAIXA_`)
  );

  // [BUG] Por alguma razão quando o fileName é falso ainda está quebrando como se não retornasse.
  // console.log("fileName: ", fileName);

  if (!fileName) return console.log("Nota não encontrada!");
  if (fileName.includes(".pdf")) await getTextFromPDF(fileName, folderPath);
  else
    await recognizeDocuments(folderPath, lang, OEM.TESSERACT_ONLY, "nota.txt");

  listarTudo(filePath, activeDate);
};

const extractData = async (recognize = false, override = false) => {
  console.clear();
  console.log(`\nEXTRAINDO DADOS: ${mes} ${ano}\n`);

  if (!exists(filePath) || recognize) await getNota(folderPath);
  if (!exists(resultPath) || override)
    getResume(filePath, resultPath, activeDate);

  createFolder(coraFolderPath);
  if (exists(importsFolderPath)) return;
  createFolder(importsFolderPath);
  writeFile(importsRecePath, CSV_HEADER_TEMPLATE);
  writeFile(importsDespPath, CSV_HEADER_TEMPLATE);
};

const extractDetails = async (folderPath, output, override = false) => {
  const filesName = readFolder(folderPath);
  const zipFile = filesName.find((name) => name.includes(".zip"));
  const path = `${folderPath}/${zipFile}`;
  const outputPath = `${folderPath}/${output}`;
  const hasPreviousFolder = exists(outputPath);

  if (hasPreviousFolder && !override) return;

  await extractZip(path, output);
  const files = readFolder(outputPath);
  await Promise.all(
    files
      .filter((name) => name.includes(".pdf"))
      .map(async (fileName) => {
        return getImagesFromPDF(`${outputPath}/${fileName}`, false);
      })
  );

  const data = require(`${folderPath}/data.json`);

  const result = hasPreviousFolder
    ? await Promise.all(
        files
          .filter((name) => name.includes(".txt"))
          .map(async (fileName) => {
            return readFile(`${outputPath}/${fileName}`);
          })
      )
    : await recognizeDocumentsBatch(4, outputPath, lang);
  // const result = await recognizeDocuments(outputPath, lang);

  result?.forEach((text) => {
    const descRgx = /Descrição\s*\r?\n(.*)/i;
    const valueRgx = /Valor\s*\r?\n(.*)/i;
    const dateRgx = /\d{2}\/\d{2}\/\d{4}/i;

    var [, matchDesc] = descRgx.exec(text) || [];
    var [, matchValue] = valueRgx.exec(text) || [];
    var [matchDate] = dateRgx.exec(text) || [];

    if (!matchDesc || !matchValue || !matchDate) return;

    const noteDate = parse(matchDate, "dd/MM/yyyy", new Date());
    const startDate = subDays(noteDate, 2);
    const endDate = addDays(noteDate, 2);

    data?.forEach(({ value, date }, index) => {
      const parsedValue = parseFloat(
        matchValue.replace("R$", "").replace(".", "").replace(",", ".").trim()
      );
      const checkDebitRgx =
        /Consulta Pix enviado|pagamento de concessionária|Pagamento de Boleto|Comprovante Boleto|Comprovante de Pix enviado|Autorização de Pix/i;
      const fixedValue = text.match(checkDebitRgx)
        ? parsedValue * -1
        : parsedValue;

      const dateToCheck = parse(date, "dd/MM/yyyy", new Date());
      const isWithinRange = isWithinInterval(dateToCheck, {
        start: startDate,
        end: endDate,
      });
      if (value === fixedValue && isWithinRange) data[index].msg = matchDesc;
    });

    writeFile(`${folderPath}/data.json`, JSON.stringify(data, null, 1));
  });
};

const printDate = () => {
  console.log(`\nDADOS DE ${parseMonth(mes).name}. DE ${ano}\n`);
};

const printOptions = () => {
  console.log("\n\nINFORME A OPERAÇÃO: \n");
  console.log("0 - SAIR");
  console.log("1 - EXTRAIR DADOS");
  console.log("2 - LISTAR SAIDAS");
  console.log("3 - LISTAR ENTRADAS");
  console.log("4 - LISTAR JUROS");
  console.log("5 - LISTAR TRANSAÇÕES");
  console.log("6 - EXIBIR RESUMO");
  console.log("7 - EXTRAIR DETALHES");
  console.log("8 - CSV PARA JSON");
  console.log("9 - ANSI TO UTF8");
  console.log("10 - FORMATAR CORA CSV");
  console.log("11 - ALTERAR DATA");
  console.log("12 - SCRIPT CAIXA");
  console.log("13 - FORMATAR CAIXA CSV\n\n");
};

const startMenu = async () => {
  prompt.start();
  console.clear();

  printOptions();

  try {
    const schema = {
      properties: {
        OP: {
          pattern: /[0-9]/,
          message: "Invalid option, check the menu above...",
          required: true,
        },
      },
    };

    const { OP } = await prompt.get(schema);

    printDate();

    switch (OP) {
      case "0":
        process.exit();
      case "1":
        await extractData(true, true);
        console.log("\nExtraido com sucesso!");
        break;
      case "2":
        const saidas = listarSaidas(listarTudo(filePath, activeDate));
        const enviopix = listarEnvioPix(saidas);
        console.log(saidas);
        console.log(`\n${enviopix.length} PIX: R$`, calcularValor(enviopix));
        console.log(
          `\nTotal de ${saidas.length} saidas: R$`,
          calcularSaidas(saidas)
        );
        break;
      case "3":
        const entradas = listarEntradas(listarTudo(filePath, activeDate));
        const credpix = listarCredPix(entradas);
        const deposito = listarDepositos(entradas);
        const outras = listarEntradas(entradas, true);
        console.log(entradas);
        console.log(`${credpix.length} CREDPIX: R$`, calcularValor(credpix));
        console.log(
          `${deposito.length} DEPÓSITOS: R$`,
          calcularValor(deposito)
        );
        console.log(`${outras.length} OUTROS: R$`, calcularValor(outras));
        console.log(
          `\nTotal de ${entradas.length} entradas: R$`,
          calcularEntradas(entradas)
        );
        break;
      case "4":
        const juros = listarJuros(listarTudo(filePath, activeDate));
        console.log(juros);
        console.log("\nTotal de juros: R$", calcularJuros(juros));
        break;
      case "5":
        console.log(listarTudo(filePath, activeDate));
        break;
      case "6":
        getResume(filePath, resultPath, activeDate);
        console.log(readFile(resultPath));
        break;
      case "7":
        await extractDetails(folderPath, "UNZIPPED");
        console.log("\nExtraido com sucesso!");
        break;
      case "8":
        const { name, number } = parseMonth(mes);
        await csvToJsonMerge(folderPath, `${number}_${name}`);
        break;
      case "9":
        await ansiToUtf8All(folderPath);
        break;
      case "10":
        await formatCoraCSV(
          `${folderPath}/cora`,
          `${folderBack(importsFolderPath)}/${shortMonth}`
        );
        console.log("\n\nCSV file successfully processed");
        break;
      case "11":
        await getParams();
        await extractData();
        console.log(`\nData alterada para ${parseMonth(mes).name}. de ${ano}`);
        break;
      case "12":
        const script = readFile("./scripts/importPixCaixaWeb.js");
        copyText(script, "Script successfully copied!");
        console.log(
          "\n\nExecute o script em https://gerenciador.caixa.gov.br/empresa/dashboard/pix/extrato"
        );
        break;

      case "13":
        await formatCaixaCSV(
          `${folderBack(folderPath)}/data.json`,
          `${folderBack(importsFolderPath)}/${shortMonth}`
        );
        console.log("\n\nCSV file successfully processed");
        break;

      default:
        startMenu();
        break;
    }

    console.log("\n\n");
    await prompt.get({
      properties: {
        continue: { message: "Pressione enter para continuar" },
      },
    });

    await startMenu();
  } catch (error) {
    console.log(error);
  }
};

(async () => {
  await getParams();
  await extractData();
  await startMenu();
  // process.exit();
})();
