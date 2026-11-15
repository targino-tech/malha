'use client';

import { Boxes, MapPin, Radio } from 'lucide-react';
import Image from 'next/image';
import { useState } from 'react';
import dashboardPreview from './painel.webp';
import styles from './site.module.css';

const topics = {
  units: {
    label: 'Unidades',
    icon: MapPin,
    title: 'Filtre por fazenda',
    description: 'Selecione uma unidade para consultar os equipamentos e os coletores daquela fazenda. A visão geral reúne todas as unidades do grupo.',
  },
  collectors: {
    label: 'Coletores',
    icon: Radio,
    title: 'Confira a última comunicação',
    description: 'Veja quais coletores estão em contato com o Malha. Quando o sinal expira, o painel preserva a data da última coleta recebida.',
  },
  assets: {
    label: 'Ativos',
    icon: Boxes,
    title: 'Encontre um equipamento',
    description: 'Consulte ativos observados via UniFi ou cadastrados por CSV. No inventário, pesquise por nome, etiqueta, IP ou MAC.',
  },
} as const;

type Topic = keyof typeof topics;

export function DashboardPreview() {
  const [selected, setSelected] = useState<Topic>('units');
  const topic = topics[selected];

  return (
    <figure className={styles.panelFigure}>
      <figcaption className={styles.panelCaption}>
        <span><Radio size={16} aria-hidden="true" /> Visão geral das fazendas</span>
        <span>Dados de demonstração</span>
      </figcaption>
      <div className={styles.previewImageWrap}>
        <Image className={styles.panelImage} src={dashboardPreview} alt="Painel Malha com a lista de fazendas e o estado de comunicação dos seus coletores" sizes="(max-width: 48rem) 94vw, 76rem" unoptimized />
        <div aria-hidden="true" className={styles.previewHighlight} data-topic={selected} />
      </div>
      <div className={styles.previewExplorer}>
        <div className={styles.previewControls} role="group" aria-label="Explorar o painel de demonstração">
          {(Object.keys(topics) as Topic[]).map((key) => {
            const { icon: Icon, label } = topics[key];
            return (
              <button
                key={key}
                type="button"
                aria-controls="malha-preview-detail"
                aria-pressed={selected === key}
                onClick={() => setSelected(key)}
              >
                <Icon size={17} aria-hidden="true" /> {label}
              </button>
            );
          })}
        </div>
        <div id="malha-preview-detail" className={styles.previewDetail} aria-live="polite" aria-atomic="true">
          <h3>{topic.title}</h3>
          <p>{topic.description}</p>
        </div>
      </div>
    </figure>
  );
}
