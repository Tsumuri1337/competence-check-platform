// Пересобирает предметный индекс компетенций (таблицы competences /
// competence_items) по src/content/competences.json. Запускать после правки
// таксономии; seed.js вызывает то же самое автоматически.
//   npm run index-competences
const { transaction, pool } = require("./db");
const { rebuildIndex } = require("./lib/competences");

transaction((client) => rebuildIndex(client))
  .then((s) => {
    console.log(
      `Индекс компетенций: ${s.competences} областей, ${s.links} связей, ${s.items - s.unmatched} из ${s.items} пунктов отнесены хотя бы к одной области.`
    );
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
