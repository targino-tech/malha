'use client';

import { Boxes, MapPin, Radio } from 'lucide-react';
import Image from 'next/image';
import { useState } from 'react';
import dashboardPreview from './painel.webp';
import styles from '../site.module.css';

const topics = {
  assets: {
    label: 'Parque',
    icon: Boxes,
    title: 'Veja o parque tecnológico inteiro',
    description: 'Todos os ativos das fazendas em uma barra só: em contato, offline, indeterminado e sem telemetria. Ao lado, coletores, críticos offline, ocorrências abertas e cobertura UniFi.',
  },
  units: {
    label: 'Unidades',
    icon: MapPin,
    title: 'Filtre por fazenda',
    description: 'Escolha uma unidade em "Todas as fazendas" para ver só os ativos, coletores e ocorrências dela. Sem filtro, a visão geral soma todas as fazendas do grupo.',
  },
  collectors: {
    label: 'Coletores',
    icon: Radio,
    title: 'Saiba quem está falando com a matriz',
    description: 'Quantos coletores estão em contato e quantas fazendas estão sem coletor. Se um coletor fica 3 minutos sem sinal, abre uma ocorrência.',
  },
} as const;

type Topic = keyof typeof topics;

export function DashboardPreview() {
  const [selected, setSelected] = useState<Topic>('assets');
  const topic = topics[selected];

  return (
    <figure className={styles.panelFigure}>
      <figcaption className={styles.panelCaption}>
        <span><Radio size={16} aria-hidden="true" /> Visão geral das fazendas</span>
        <span>Dados de demonstração</span>
      </figcaption>
      <div className={styles.previewImageWrap}>
        <Image className={styles.panelImage} src={dashboardPreview} alt="Visão geral do painel Malha no tema escuro: parque tecnológico com 8 ativos em 3 fazendas, coletores em contato, críticos offline, ocorrências abertas, cobertura UniFi e a lista de ocorrências abertas" sizes="(max-width: 48rem) 94vw, 76rem" unoptimized />
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
          <div key={selected} className={styles.previewDetailBody}>
            <h3>{topic.title}</h3>
            <p>{topic.description}</p>
          </div>
        </div>
      </div>
    </figure>
  );
}
